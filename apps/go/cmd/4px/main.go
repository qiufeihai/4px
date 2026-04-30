package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Config struct {
	SocksListen              string `json:"socks_listen"`
	HTTPListen               string `json:"http_listen"`
	UpstreamHost             string `json:"upstream_host"`
	UpstreamPort             int    `json:"upstream_port"`
	ServerName               string `json:"server_name"`
	AuthToken                string `json:"auth_token"`
	RejectUnauthorized       bool   `json:"reject_unauthorized"`
	CAFile                   string `json:"ca_file"`
	UpstreamConnectTimeoutMS int    `json:"upstream_connect_timeout_ms"`
	ResponseHeaderTimeoutMS  int    `json:"response_header_timeout_ms"`
	IdleTimeoutMS            int    `json:"idle_timeout_ms"`
	LogLevel                 string `json:"log_level"`
}

var (
	levelOrder = map[string]int{
		"DEBUG": 10,
		"INFO":  20,
		"WARN":  30,
		"ERROR": 40,
	}
	currentLogLevel = "INFO"
)

func main() {
	configPath, action, err := parseArgs(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		fmt.Fprintln(os.Stderr, usage())
		os.Exit(1)
	}

	cfg, err := loadConfig(configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "load config failed: %v\n", err)
		os.Exit(1)
	}

	currentLogLevel = normalizeLogLevel(cfg.LogLevel)
	if v := os.Getenv("LOG_LEVEL"); v != "" {
		currentLogLevel = normalizeLogLevel(v)
	}

	switch action {
	case "run":
		if err := runProxy(cfg); err != nil {
			logf("ERROR", "run failed: %v", err)
			os.Exit(1)
		}
	case "sysproxy-enable":
		if err := setSystemProxy(cfg, true); err != nil {
			logf("ERROR", "enable system proxy failed: %v", err)
			os.Exit(1)
		}
		logf("INFO", "system proxy enabled")
	case "sysproxy-disable":
		if err := setSystemProxy(cfg, false); err != nil {
			logf("ERROR", "disable system proxy failed: %v", err)
			os.Exit(1)
		}
		logf("INFO", "system proxy disabled")
	case "sysproxy-status":
		if err := showSystemProxyStatus(); err != nil {
			logf("ERROR", "system proxy status failed: %v", err)
			os.Exit(1)
		}
	default:
		fmt.Fprintln(os.Stderr, usage())
		os.Exit(1)
	}
}

func parseArgs(args []string) (configPath, action string, err error) {
	configPath = "config/client.json"
	action = "run"
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "-c":
			if i+1 >= len(args) {
				return "", "", errors.New("missing value for -c")
			}
			configPath = args[i+1]
			i++
		case "run", "sysproxy-enable", "sysproxy-disable", "sysproxy-status":
			action = args[i]
		default:
			return "", "", fmt.Errorf("unknown arg: %s", args[i])
		}
	}
	return configPath, action, nil
}

func usage() string {
	return "Usage: 4px [-c config/client.json] [run|sysproxy-enable|sysproxy-disable|sysproxy-status]"
}

func loadConfig(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	if cfg.SocksListen == "" {
		cfg.SocksListen = "127.0.0.1:7777"
	}
	if cfg.HTTPListen == "" {
		cfg.HTTPListen = "127.0.0.1:7788"
	}
	if cfg.UpstreamConnectTimeoutMS <= 0 {
		cfg.UpstreamConnectTimeoutMS = 15000
	}
	if cfg.ResponseHeaderTimeoutMS <= 0 {
		cfg.ResponseHeaderTimeoutMS = 10000
	}
	if cfg.IdleTimeoutMS <= 0 {
		cfg.IdleTimeoutMS = 120000
	}
	return &cfg, nil
}

func runProxy(cfg *Config) error {
	client, err := newHTTPClient(cfg)
	if err != nil {
		return err
	}

	socksLn, err := net.Listen("tcp", cfg.SocksListen)
	if err != nil {
		return err
	}
	defer socksLn.Close()

	logf("INFO", "go client started socks5://%s -> %s:%d", cfg.SocksListen, cfg.UpstreamHost, cfg.UpstreamPort)
	var httpLn net.Listener
	if cfg.HTTPListen != "" {
		httpLn, err = net.Listen("tcp", cfg.HTTPListen)
		if err != nil {
			return err
		}
		defer httpLn.Close()
		logf("INFO", "go client started http://%s (http proxy)", cfg.HTTPListen)
	}

	errCh := make(chan error, 2)
	go acceptSOCKS(socksLn, cfg, client, errCh)
	if httpLn != nil {
		go acceptHTTPProxy(httpLn, cfg, client, errCh)
	}

	return <-errCh
}

func acceptSOCKS(ln net.Listener, cfg *Config, client *http.Client, errCh chan<- error) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			errCh <- fmt.Errorf("socks accept failed: %w", err)
			return
		}
		go handleSOCKSConn(conn, cfg, client)
	}
}

func acceptHTTPProxy(ln net.Listener, cfg *Config, client *http.Client, errCh chan<- error) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			errCh <- fmt.Errorf("http proxy accept failed: %w", err)
			return
		}
		go handleHTTPProxyConn(conn, cfg, client)
	}
}

func newHTTPClient(cfg *Config) (*http.Client, error) {
	tlsCfg := &tls.Config{
		ServerName:         cfg.ServerName,
		InsecureSkipVerify: !cfg.RejectUnauthorized, // nolint:gosec
		MinVersion:         tls.VersionTLS12,
	}

	if cfg.CAFile != "" {
		caBytes, err := os.ReadFile(cfg.CAFile)
		if err != nil {
			return nil, fmt.Errorf("read ca file: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(caBytes) {
			return nil, errors.New("parse ca file failed")
		}
		tlsCfg.RootCAs = pool
	}

	transport := &http.Transport{
		Proxy: nil, // prevent loop when system proxy is enabled
		DialContext: (&net.Dialer{
			Timeout:   time.Duration(cfg.UpstreamConnectTimeoutMS) * time.Millisecond,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		TLSClientConfig:       tlsCfg,
		ForceAttemptHTTP2:     true,
		TLSHandshakeTimeout:   time.Duration(cfg.UpstreamConnectTimeoutMS) * time.Millisecond,
		ResponseHeaderTimeout: time.Duration(cfg.ResponseHeaderTimeoutMS) * time.Millisecond,
		IdleConnTimeout:       time.Duration(cfg.IdleTimeoutMS) * time.Millisecond,
		MaxIdleConns:          200,
		MaxIdleConnsPerHost:   200,
		MaxConnsPerHost:       0,
	}

	return &http.Client{
		Transport: transport,
		Timeout:   0,
	}, nil
}

func handleSOCKSConn(conn net.Conn, cfg *Config, client *http.Client) {
	defer conn.Close()
	peer := conn.RemoteAddr().String()

	targetHost, targetPort, err := socks5Handshake(conn)
	if err != nil {
		logf("WARN", "socks handshake failed peer=%s err=%v", peer, err)
		return
	}

	target := net.JoinHostPort(targetHost, strconv.Itoa(targetPort))
	logf("DEBUG", "socks connect peer=%s target=%s", peer, target)

	targetEncoded := base64.RawURLEncoding.EncodeToString([]byte(target))
	url := fmt.Sprintf("https://%s:%d/proxy", cfg.UpstreamHost, cfg.UpstreamPort)
	pr, pw := io.Pipe()

	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, url, pr)
	if err != nil {
		logf("ERROR", "build request failed peer=%s err=%v", peer, err)
		return
	}
	req.Header.Set("x-auth-token", cfg.AuthToken)
	req.Header.Set("x-target", targetEncoded)

	resp, err := client.Do(req)
	if err != nil {
		_ = pw.CloseWithError(err)
		logf("WARN", "upstream request failed peer=%s target=%s err=%v", peer, target, err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		_ = pw.CloseWithError(fmt.Errorf("status=%d", resp.StatusCode))
		logf("WARN", "upstream rejected peer=%s target=%s status=%d", peer, target, resp.StatusCode)
		return
	}

	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		_, copyErr := io.Copy(pw, conn)
		_ = pw.CloseWithError(copyErr)
	}()

	go func() {
		defer wg.Done()
		_, _ = io.Copy(conn, resp.Body)
	}()

	wg.Wait()
}

func handleHTTPProxyConn(conn net.Conn, cfg *Config, client *http.Client) {
	defer conn.Close()
	peer := conn.RemoteAddr().String()
	reader := bufio.NewReader(conn)

	req, err := http.ReadRequest(reader)
	if err != nil {
		logf("WARN", "http proxy read request failed peer=%s err=%v", peer, err)
		return
	}
	defer req.Body.Close()

	if strings.EqualFold(req.Method, http.MethodConnect) {
		target := req.Host
		if !strings.Contains(target, ":") {
			target = target + ":443"
		}
		logf("DEBUG", "http proxy connect peer=%s target=%s", peer, target)

		respBody, pw, err := openUpstreamTunnel(client, cfg, target)
		if err != nil {
			logf("WARN", "http connect upstream failed peer=%s target=%s err=%v", peer, target, err)
			_, _ = conn.Write([]byte("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n"))
			return
		}
		defer respBody.Close()
		_, _ = conn.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))

		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			_, copyErr := io.Copy(pw, reader)
			_ = pw.CloseWithError(copyErr)
		}()
		go func() {
			defer wg.Done()
			_, _ = io.Copy(conn, respBody)
		}()
		wg.Wait()
		return
	}

	target := req.URL.Host
	if target == "" {
		target = req.Host
	}
	if !strings.Contains(target, ":") {
		target = target + ":80"
	}
	logf("DEBUG", "http proxy request peer=%s method=%s target=%s", peer, req.Method, target)

	respBody, pw, err := openUpstreamTunnel(client, cfg, target)
	if err != nil {
		logf("WARN", "http request upstream failed peer=%s target=%s err=%v", peer, target, err)
		_, _ = conn.Write([]byte("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n"))
		return
	}
	defer respBody.Close()

	// Proxy request uses absolute URL form, convert to origin form before forwarding to target server.
	req.URL.Scheme = ""
	req.URL.Host = ""
	req.RequestURI = ""
	if err := req.Write(pw); err != nil {
		_ = pw.CloseWithError(err)
		logf("WARN", "http request write upstream failed peer=%s target=%s err=%v", peer, target, err)
		return
	}
	_ = pw.Close()

	_, _ = io.Copy(conn, respBody)
}

func openUpstreamTunnel(client *http.Client, cfg *Config, target string) (io.ReadCloser, *io.PipeWriter, error) {
	targetEncoded := base64.RawURLEncoding.EncodeToString([]byte(target))
	url := fmt.Sprintf("https://%s:%d/proxy", cfg.UpstreamHost, cfg.UpstreamPort)
	pr, pw := io.Pipe()

	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, url, pr)
	if err != nil {
		_ = pw.Close()
		return nil, nil, err
	}
	req.Header.Set("x-auth-token", cfg.AuthToken)
	req.Header.Set("x-target", targetEncoded)

	resp, err := client.Do(req)
	if err != nil {
		_ = pw.CloseWithError(err)
		return nil, nil, err
	}
	if resp.StatusCode != http.StatusOK {
		_ = pw.CloseWithError(fmt.Errorf("status=%d", resp.StatusCode))
		defer resp.Body.Close()
		return nil, nil, fmt.Errorf("upstream status=%d", resp.StatusCode)
	}
	return resp.Body, pw, nil
}

func socks5Handshake(conn net.Conn) (string, int, error) {
	reader := bufio.NewReader(conn)

	head := make([]byte, 2)
	if _, err := io.ReadFull(reader, head); err != nil {
		return "", 0, err
	}
	if head[0] != 0x05 {
		return "", 0, errors.New("only socks5")
	}

	methodN := int(head[1])
	methods := make([]byte, methodN)
	if _, err := io.ReadFull(reader, methods); err != nil {
		return "", 0, err
	}

	_, _ = conn.Write([]byte{0x05, 0x00}) // no auth

	reqHead := make([]byte, 4)
	if _, err := io.ReadFull(reader, reqHead); err != nil {
		return "", 0, err
	}
	if reqHead[0] != 0x05 || reqHead[1] != 0x01 {
		_, _ = conn.Write([]byte{0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
		return "", 0, errors.New("only connect command")
	}

	atyp := reqHead[3]
	var host string
	switch atyp {
	case 0x01: // ipv4
		buf := make([]byte, 4)
		if _, err := io.ReadFull(reader, buf); err != nil {
			return "", 0, err
		}
		host = net.IP(buf).String()
	case 0x03: // domain
		lenBuf := make([]byte, 1)
		if _, err := io.ReadFull(reader, lenBuf); err != nil {
			return "", 0, err
		}
		n := int(lenBuf[0])
		d := make([]byte, n)
		if _, err := io.ReadFull(reader, d); err != nil {
			return "", 0, err
		}
		host = string(d)
	case 0x04: // ipv6
		buf := make([]byte, 16)
		if _, err := io.ReadFull(reader, buf); err != nil {
			return "", 0, err
		}
		host = net.IP(buf).String()
	default:
		return "", 0, errors.New("unsupported atyp")
	}

	portBuf := make([]byte, 2)
	if _, err := io.ReadFull(reader, portBuf); err != nil {
		return "", 0, err
	}
	port := int(portBuf[0])<<8 | int(portBuf[1])

	_, _ = conn.Write([]byte{0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
	return host, port, nil
}

func setSystemProxy(cfg *Config, enable bool) error {
	socksHost, socksPort, err := splitHostPort(cfg.SocksListen)
	if err != nil {
		return err
	}
	httpHost, httpPort, err := splitHostPort(cfg.HTTPListen)
	if err != nil {
		return err
	}
	logf("INFO", "set system proxy os=%s enable=%v socks=%s:%d http=%s:%d", runtime.GOOS, enable, socksHost, socksPort, httpHost, httpPort)

	switch runtime.GOOS {
	case "darwin":
		return setMacProxy(httpHost, httpPort, socksHost, socksPort, enable)
	case "windows":
		return setWindowsProxy(httpHost, httpPort, socksHost, socksPort, enable)
	case "linux":
		return setLinuxProxy(httpHost, httpPort, socksHost, socksPort, enable)
	default:
		return fmt.Errorf("unsupported os: %s", runtime.GOOS)
	}
}

func showSystemProxyStatus() error {
	logf("INFO", "query system proxy status os=%s", runtime.GOOS)
	switch runtime.GOOS {
	case "darwin":
		services, err := macNetworkServices()
		if err != nil {
			return err
		}
		for _, svc := range services {
			out, cmdErr := runOutput("networksetup", "-getwebproxy", svc)
			if cmdErr != nil {
				logf("WARN", "status %s failed: %v", svc, cmdErr)
				continue
			}
			fmt.Printf("[%s] web\n%s\n", svc, strings.TrimSpace(out))
			out, _ = runOutput("networksetup", "-getsecurewebproxy", svc)
			fmt.Printf("[%s] secureweb\n%s\n", svc, strings.TrimSpace(out))
			out, _ = runOutput("networksetup", "-getsocksfirewallproxy", svc)
			fmt.Printf("[%s] socks\n%s\n", svc, strings.TrimSpace(out))
		}
		return nil
	case "windows":
		out, err := runOutput("reg", "query", `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`, "/v", "ProxyEnable")
		if err != nil {
			return err
		}
		fmt.Println(strings.TrimSpace(out))
		out, err = runOutput("reg", "query", `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`, "/v", "ProxyServer")
		if err != nil {
			return err
		}
		fmt.Println(strings.TrimSpace(out))
		return nil
	case "linux":
		out, err := runOutput("sh", "-c", "gsettings get org.gnome.system.proxy mode 2>/dev/null || echo gsettings-not-available")
		if err != nil {
			return err
		}
		fmt.Println(strings.TrimSpace(out))
		out, err = runOutput("sh", "-c", "gsettings get org.gnome.system.proxy.socks host 2>/dev/null || true")
		if err == nil {
			fmt.Println(strings.TrimSpace(out))
		}
		out, err = runOutput("sh", "-c", "gsettings get org.gnome.system.proxy.socks port 2>/dev/null || true")
		if err == nil {
			fmt.Println(strings.TrimSpace(out))
		}
		return nil
	default:
		return fmt.Errorf("unsupported os: %s", runtime.GOOS)
	}
}

func setMacProxy(httpHost string, httpPort int, socksHost string, socksPort int, enable bool) error {
	services, err := macNetworkServices()
	if err != nil {
		return err
	}
	logf("INFO", "mac network services=%d", len(services))
	httpPortStr := strconv.Itoa(httpPort)
	socksPortStr := strconv.Itoa(socksPort)
	for _, svc := range services {
		logf("INFO", "apply mac proxy service=%s enable=%v", svc, enable)
		if enable {
			if _, err := runOutput("networksetup", "-setwebproxy", svc, httpHost, httpPortStr); err != nil {
				return err
			}
			if _, err := runOutput("networksetup", "-setsecurewebproxy", svc, httpHost, httpPortStr); err != nil {
				return err
			}
			if _, err := runOutput("networksetup", "-setsocksfirewallproxy", svc, socksHost, socksPortStr); err != nil {
				return err
			}
			if _, err := runOutput("networksetup", "-setwebproxystate", svc, "on"); err != nil {
				return err
			}
			if _, err := runOutput("networksetup", "-setsecurewebproxystate", svc, "on"); err != nil {
				return err
			}
			if _, err := runOutput("networksetup", "-setsocksfirewallproxystate", svc, "on"); err != nil {
				return err
			}
		} else {
			if _, err := runOutput("networksetup", "-setwebproxystate", svc, "off"); err != nil {
				return err
			}
			if _, err := runOutput("networksetup", "-setsecurewebproxystate", svc, "off"); err != nil {
				return err
			}
			if _, err := runOutput("networksetup", "-setsocksfirewallproxystate", svc, "off"); err != nil {
				return err
			}
		}
	}
	return nil
}

func setWindowsProxy(httpHost string, httpPort int, socksHost string, socksPort int, enable bool) error {
	logf("INFO", "apply windows proxy enable=%v", enable)
	if enable {
		server := fmt.Sprintf("http=%s:%d;https=%s:%d;socks=%s:%d", httpHost, httpPort, httpHost, httpPort, socksHost, socksPort)
		if _, err := runOutput("reg", "add", `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`, "/v", "ProxyServer", "/t", "REG_SZ", "/d", server, "/f"); err != nil {
			return err
		}
		if _, err := runOutput("reg", "add", `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "1", "/f"); err != nil {
			return err
		}
		return nil
	}
	if _, err := runOutput("reg", "add", `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "0", "/f"); err != nil {
		return err
	}
	return nil
}

func setLinuxProxy(httpHost string, httpPort int, socksHost string, socksPort int, enable bool) error {
	logf("INFO", "apply linux proxy enable=%v", enable)
	if _, err := exec.LookPath("gsettings"); err != nil {
		return errors.New("gsettings not found, please set system proxy manually")
	}

	if enable {
		if _, err := runOutput("gsettings", "set", "org.gnome.system.proxy", "mode", "manual"); err != nil {
			return err
		}
		if _, err := runOutput("gsettings", "set", "org.gnome.system.proxy.http", "host", httpHost); err != nil {
			return err
		}
		if _, err := runOutput("gsettings", "set", "org.gnome.system.proxy.http", "port", strconv.Itoa(httpPort)); err != nil {
			return err
		}
		if _, err := runOutput("gsettings", "set", "org.gnome.system.proxy.https", "host", httpHost); err != nil {
			return err
		}
		if _, err := runOutput("gsettings", "set", "org.gnome.system.proxy.https", "port", strconv.Itoa(httpPort)); err != nil {
			return err
		}
		if _, err := runOutput("gsettings", "set", "org.gnome.system.proxy.socks", "host", socksHost); err != nil {
			return err
		}
		if _, err := runOutput("gsettings", "set", "org.gnome.system.proxy.socks", "port", strconv.Itoa(socksPort)); err != nil {
			return err
		}
		return nil
	}

	if _, err := runOutput("gsettings", "set", "org.gnome.system.proxy", "mode", "none"); err != nil {
		return err
	}
	return nil
}

func macNetworkServices() ([]string, error) {
	out, err := runOutput("networksetup", "-listallnetworkservices")
	if err != nil {
		return nil, err
	}
	lines := strings.Split(out, "\n")
	services := make([]string, 0, len(lines))
	for _, line := range lines {
		trim := strings.TrimSpace(line)
		if trim == "" || strings.HasPrefix(trim, "An asterisk") || strings.HasPrefix(trim, "*") {
			continue
		}
		services = append(services, trim)
	}
	if len(services) == 0 {
		return nil, errors.New("no network service found")
	}
	logf("DEBUG", "detected mac services: %s", strings.Join(services, ", "))
	return services, nil
}

func runOutput(name string, args ...string) (string, error) {
	logf("DEBUG", "exec: %s %s", name, strings.Join(args, " "))
	cmd := exec.Command(name, args...) // nolint:gosec
	out, err := cmd.CombinedOutput()
	if err != nil {
		logf("ERROR", "exec failed: %s %s output=%s", name, strings.Join(args, " "), strings.TrimSpace(string(out)))
		return string(out), fmt.Errorf("%s %v failed: %w, output=%s", name, args, err, strings.TrimSpace(string(out)))
	}
	if len(strings.TrimSpace(string(out))) > 0 {
		logf("DEBUG", "exec output: %s", strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

func splitHostPort(addr string) (string, int, error) {
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		return "", 0, err
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		return "", 0, err
	}
	return host, port, nil
}

func normalizeLogLevel(v string) string {
	l := strings.ToUpper(strings.TrimSpace(v))
	if _, ok := levelOrder[l]; !ok {
		return "INFO"
	}
	return l
}

func logf(level string, format string, args ...any) {
	l := normalizeLogLevel(level)
	if levelOrder[l] < levelOrder[currentLogLevel] {
		return
	}
	msg := fmt.Sprintf(format, args...)
	log.Printf("[go-client][%s][%s] %s", time.Now().UTC().Format(time.RFC3339), l, msg)
}
