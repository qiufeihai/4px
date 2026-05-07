package clientcore

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
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
	"unicode/utf16"
	"unicode/utf8"

	"golang.org/x/net/http2"
	"golang.org/x/text/encoding/simplifiedchinese"
)

type Config struct {
	SocksListen              string `json:"socks_listen"`
	HTTPListen               string `json:"http_listen"`
	UpstreamHost             string `json:"upstream_host"`
	UpstreamPort             int    `json:"upstream_port"`
	UpstreamPath             string `json:"upstream_path"`
	ServerName               string `json:"server_name"`
	AuthToken                string `json:"auth_token"`
	RejectUnauthorized       bool   `json:"reject_unauthorized"`
	CAFile                   string `json:"ca_file"`
	UpstreamConnectTimeoutMS int    `json:"upstream_connect_timeout_ms"`
	ResponseHeaderTimeoutMS  int    `json:"response_header_timeout_ms"`
	IdleTimeoutMS            int    `json:"idle_timeout_ms"`
	LogLevel                 string `json:"log_level"`
	UpstreamMaxIdleConns     int    `json:"upstream_max_idle_conns"`
	UpstreamMaxIdlePerHost   int    `json:"upstream_max_idle_conns_per_host"`
	UpstreamMaxConnsPerHost  int    `json:"upstream_max_conns_per_host"`
	UpstreamDisableCompress  bool   `json:"upstream_disable_compression"`
	UpstreamH2ReadIdleMS     int    `json:"upstream_h2_read_idle_timeout_ms"`
	UpstreamH2PingTimeoutMS  int    `json:"upstream_h2_ping_timeout_ms"`
	ClientInstanceID         string `json:"client_instance_id"`
}

type proxyRuntime struct {
	cfg         *Config
	client      *http.Client
	upstreamURL string
	authToken   string
	clientID    string
}

type MuxRuntimeStats struct {
	ReconnectTotal   uint64 `json:"reconnectTotal"`
	LastReconnectErr string `json:"lastReconnectErr"`
	Connected        bool   `json:"connected"`
}

var (
	levelOrder = map[string]int{
		"DEBUG": 10,
		"INFO":  20,
		"WARN":  30,
		"ERROR": 40,
	}
	currentLogLevel = "INFO"
	copyBufferPool  = sync.Pool{
		New: func() any {
			buf := make([]byte, 32*1024)
			return &buf
		},
	}
)

const defaultClientConfigTemplate = `{
  "socks_listen": "127.0.0.1:7777",
  "http_listen": "127.0.0.1:7788",
  "upstream_host": "your-server-ip",
  "upstream_port": 6666,
  "upstream_path": "/proxy",
  "server_name": "your-domain.com",
  "auth_token": "change-me-strong-token",
  "reject_unauthorized": true,
  "ca_file": "",
  "upstream_connect_timeout_ms": 15000,
  "response_header_timeout_ms": 30000,
  "idle_timeout_ms": 300000,
  "upstream_max_idle_conns": 512,
  "upstream_max_idle_conns_per_host": 512,
  "upstream_max_conns_per_host": 0,
  "upstream_disable_compression": true,
  "upstream_h2_read_idle_timeout_ms": 30000,
  "upstream_h2_ping_timeout_ms": 10000,
  "client_instance_id": "",
  "log_level": "INFO"
}
`

func RunCLI(args []string) int {
	configPath, action, configExplicit, err := parseArgs(args)
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		fmt.Fprintln(os.Stderr, usage())
		return 1
	}

	created, err := ensureConfigIfMissing(configPath, configExplicit)
	if err != nil {
		fmt.Fprintf(os.Stderr, "init config failed: %v\n", err)
		return 1
	}
	if created {
		fmt.Fprintf(os.Stderr, "config not found, created template: %s\n", configPath)
		fmt.Fprintln(os.Stderr, "please edit it and restart.")
		return 0
	}

	cfg, err := loadConfig(configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "load config failed: %v\n", err)
		return 1
	}

	currentLogLevel = normalizeLogLevel(cfg.LogLevel)
	if v := os.Getenv("LOG_LEVEL"); v != "" {
		currentLogLevel = normalizeLogLevel(v)
	}

	switch action {
	case "run":
		if err := RunProxyWithContext(context.Background(), cfg); err != nil {
			logf("ERROR", "run failed: %v", err)
			return 1
		}
	case "sysproxy-enable":
		if err := SetSystemProxy(cfg, true); err != nil {
			logf("ERROR", "enable system proxy failed: %v", err)
			return 1
		}
		logf("INFO", "system proxy enabled")
	case "sysproxy-disable":
		if err := SetSystemProxy(cfg, false); err != nil {
			logf("ERROR", "disable system proxy failed: %v", err)
			return 1
		}
		logf("INFO", "system proxy disabled")
	case "sysproxy-status":
		out, statusErr := GetSystemProxyStatus()
		if statusErr != nil {
			logf("ERROR", "system proxy status failed: %v", statusErr)
			return 1
		}
		fmt.Print(out)
	default:
		fmt.Fprintln(os.Stderr, usage())
		return 1
	}
	return 0
}

func EnsureConfigIfMissing(path string, configExplicit bool) (bool, error) {
	return ensureConfigIfMissing(path, configExplicit)
}

func LoadConfig(path string) (*Config, error) {
	return loadConfig(path)
}

func SetSystemProxy(cfg *Config, enable bool) error {
	return setSystemProxy(cfg, enable)
}

func GetSystemProxyStatus() (string, error) {
	switch runtime.GOOS {
	case "darwin":
		services, err := macNetworkServices()
		if err != nil {
			return "", err
		}
		var b strings.Builder
		for _, svc := range services {
			out, cmdErr := runOutput("networksetup", "-getwebproxy", svc)
			if cmdErr != nil {
				continue
			}
			b.WriteString(fmt.Sprintf("[%s] web\n%s\n", svc, strings.TrimSpace(out)))
			out, _ = runOutput("networksetup", "-getsecurewebproxy", svc)
			b.WriteString(fmt.Sprintf("[%s] secureweb\n%s\n", svc, strings.TrimSpace(out)))
			out, _ = runOutput("networksetup", "-getsocksfirewallproxy", svc)
			b.WriteString(fmt.Sprintf("[%s] socks\n%s\n", svc, strings.TrimSpace(out)))
		}
		return b.String(), nil
	case "windows":
		const regPath = `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`
		var b strings.Builder
		out, err := runOutput("reg", "query", regPath, "/v", "ProxyEnable")
		if err != nil {
			// Value may be absent on clean systems; treat as disabled instead of hard-fail.
			logf("WARN", "windows proxy status fallback ProxyEnable missing: %v", err)
			b.WriteString("ProxyEnable    REG_DWORD    0x0\n")
		} else {
			b.WriteString(strings.TrimSpace(out) + "\n")
		}
		out, err = runOutput("reg", "query", regPath, "/v", "ProxyServer")
		if err != nil {
			// ProxyServer can be unset when proxy is disabled.
			logf("WARN", "windows proxy status fallback ProxyServer missing: %v", err)
			b.WriteString("ProxyServer    <not set>\n")
		} else {
			b.WriteString(strings.TrimSpace(out) + "\n")
		}
		return b.String(), nil
	case "linux":
		var b strings.Builder
		out, err := runOutput("sh", "-c", "gsettings get org.gnome.system.proxy mode 2>/dev/null || echo gsettings-not-available")
		if err != nil {
			return "", err
		}
		b.WriteString(strings.TrimSpace(out) + "\n")
		out, err = runOutput("sh", "-c", "gsettings get org.gnome.system.proxy.socks host 2>/dev/null || true")
		if err == nil {
			b.WriteString(strings.TrimSpace(out) + "\n")
		}
		out, err = runOutput("sh", "-c", "gsettings get org.gnome.system.proxy.socks port 2>/dev/null || true")
		if err == nil {
			b.WriteString(strings.TrimSpace(out) + "\n")
		}
		return b.String(), nil
	default:
		return "", fmt.Errorf("unsupported os: %s", runtime.GOOS)
	}
}

func GetMuxRuntimeStats() MuxRuntimeStats {
	// Proxy-only build: keep API compatibility for GUI status panel.
	return MuxRuntimeStats{}
}

func RunProxyWithContext(ctx context.Context, cfg *Config) error {
	client, err := newHTTPClient(cfg)
	if err != nil {
		return err
	}
	rt := &proxyRuntime{
		cfg:         cfg,
		client:      client,
		upstreamURL: fmt.Sprintf("https://%s:%d%s", cfg.UpstreamHost, cfg.UpstreamPort, cfg.UpstreamPath),
		authToken:   cfg.AuthToken,
		clientID:    resolveClientInstanceID(cfg),
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
	tracker := newConnTracker()
	go acceptSOCKSWithContext(ctx, socksLn, rt, errCh, tracker)
	if httpLn != nil {
		go acceptHTTPProxyWithContext(ctx, httpLn, rt, errCh, tracker)
	}
	go func() {
		<-ctx.Done()
		_ = socksLn.Close()
		if httpLn != nil {
			_ = httpLn.Close()
		}
		tracker.CloseAll()
	}()

	for {
		select {
		case <-ctx.Done():
			return nil
		case e := <-errCh:
			if e == nil || errors.Is(e, net.ErrClosed) || ctx.Err() != nil {
				return nil
			}
			return e
		}
	}
}

func acceptSOCKSWithContext(ctx context.Context, ln net.Listener, rt *proxyRuntime, errCh chan<- error, tracker *connTracker) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				errCh <- nil
				return
			}
			errCh <- fmt.Errorf("socks accept failed: %w", err)
			return
		}
		if tcpConn, ok := conn.(*net.TCPConn); ok {
			_ = tcpConn.SetNoDelay(true)
			_ = tcpConn.SetKeepAlive(true)
		}
		conn = tracker.Wrap(conn)
		go handleSOCKSConn(conn, rt)
	}
}

func acceptHTTPProxyWithContext(ctx context.Context, ln net.Listener, rt *proxyRuntime, errCh chan<- error, tracker *connTracker) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				errCh <- nil
				return
			}
			errCh <- fmt.Errorf("http proxy accept failed: %w", err)
			return
		}
		if tcpConn, ok := conn.(*net.TCPConn); ok {
			_ = tcpConn.SetNoDelay(true)
			_ = tcpConn.SetKeepAlive(true)
		}
		conn = tracker.Wrap(conn)
		go handleHTTPProxyConn(conn, rt)
	}
}

type connTracker struct {
	mu    sync.Mutex
	conns map[net.Conn]struct{}
}

func newConnTracker() *connTracker {
	return &connTracker{
		conns: make(map[net.Conn]struct{}),
	}
}

func (t *connTracker) Wrap(conn net.Conn) net.Conn {
	t.mu.Lock()
	t.conns[conn] = struct{}{}
	t.mu.Unlock()
	return &trackedConn{
		Conn: conn,
		done: func() {
			t.mu.Lock()
			delete(t.conns, conn)
			t.mu.Unlock()
		},
	}
}

func (t *connTracker) CloseAll() {
	t.mu.Lock()
	conns := make([]net.Conn, 0, len(t.conns))
	for c := range t.conns {
		conns = append(conns, c)
	}
	t.mu.Unlock()

	for _, c := range conns {
		_ = c.Close()
	}
}

type trackedConn struct {
	net.Conn
	once sync.Once
	done func()
}

func (c *trackedConn) Close() error {
	c.once.Do(c.done)
	return c.Conn.Close()
}

type tunnelRW struct {
	r io.ReadCloser
	w *io.PipeWriter
}

func (t *tunnelRW) Read(p []byte) (int, error) {
	return t.r.Read(p)
}

func (t *tunnelRW) Write(p []byte) (int, error) {
	return t.w.Write(p)
}

func (t *tunnelRW) Close() error {
	_ = t.w.Close()
	return t.r.Close()
}

type writeCloserWithErr interface {
	io.WriteCloser
	CloseWithError(error) error
}

func showSystemProxyStatus() error {
	out, err := GetSystemProxyStatus()
	if err != nil {
		logf("ERROR", "system proxy status failed: %v", err)
		return err
	}
	fmt.Print(out)
	return nil
}

func parseArgs(args []string) (configPath, action string, configExplicit bool, err error) {
	configPath = "client.json"
	action = "run"
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "-c":
			if i+1 >= len(args) {
				return "", "", false, errors.New("missing value for -c")
			}
			configPath = args[i+1]
			configExplicit = true
			i++
		case "run", "sysproxy-enable", "sysproxy-disable", "sysproxy-status":
			action = args[i]
		default:
			return "", "", false, fmt.Errorf("unknown arg: %s", args[i])
		}
	}
	return configPath, action, configExplicit, nil
}

func usage() string {
	return "Usage: 4px [-c client.json] [run|sysproxy-enable|sysproxy-disable|sysproxy-status]"
}

func ensureConfigIfMissing(path string, configExplicit bool) (bool, error) {
	if configExplicit {
		return false, nil
	}
	_, err := os.Stat(path)
	if err == nil {
		return false, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	if err := os.WriteFile(path, []byte(defaultClientConfigTemplate), 0o644); err != nil {
		return false, err
	}
	return true, nil
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
	if strings.TrimSpace(cfg.UpstreamPath) == "" {
		cfg.UpstreamPath = "/proxy"
	}
	if !strings.HasPrefix(cfg.UpstreamPath, "/") {
		cfg.UpstreamPath = "/" + cfg.UpstreamPath
	}
	// Keep runtime behavior stable: this build is proxy-only.
	if cfg.UpstreamPath != "/proxy" {
		cfg.UpstreamPath = "/proxy"
	}
	if cfg.UpstreamConnectTimeoutMS <= 0 {
		cfg.UpstreamConnectTimeoutMS = 15000
	}
	if cfg.ResponseHeaderTimeoutMS <= 0 {
		cfg.ResponseHeaderTimeoutMS = 30000
	}
	if cfg.IdleTimeoutMS <= 0 {
		cfg.IdleTimeoutMS = 300000
	}
	if cfg.UpstreamMaxIdleConns <= 0 {
		cfg.UpstreamMaxIdleConns = 512
	}
	if cfg.UpstreamMaxIdlePerHost <= 0 {
		cfg.UpstreamMaxIdlePerHost = 512
	}
	if cfg.UpstreamH2ReadIdleMS <= 0 {
		cfg.UpstreamH2ReadIdleMS = 30000
	}
	if cfg.UpstreamH2PingTimeoutMS <= 0 {
		cfg.UpstreamH2PingTimeoutMS = 10000
	}
	return &cfg, nil
}

func runProxy(cfg *Config) error {
	client, err := newHTTPClient(cfg)
	if err != nil {
		return err
	}
	rt := &proxyRuntime{
		cfg:         cfg,
		client:      client,
		upstreamURL: fmt.Sprintf("https://%s:%d%s", cfg.UpstreamHost, cfg.UpstreamPort, cfg.UpstreamPath),
		authToken:   cfg.AuthToken,
		clientID:    resolveClientInstanceID(cfg),
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
	go acceptSOCKS(socksLn, rt, errCh)
	if httpLn != nil {
		go acceptHTTPProxy(httpLn, rt, errCh)
	}

	return <-errCh
}

func acceptSOCKS(ln net.Listener, rt *proxyRuntime, errCh chan<- error) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			errCh <- fmt.Errorf("socks accept failed: %w", err)
			return
		}
		if tcpConn, ok := conn.(*net.TCPConn); ok {
			_ = tcpConn.SetNoDelay(true)
			_ = tcpConn.SetKeepAlive(true)
		}
		go handleSOCKSConn(conn, rt)
	}
}

func acceptHTTPProxy(ln net.Listener, rt *proxyRuntime, errCh chan<- error) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			errCh <- fmt.Errorf("http proxy accept failed: %w", err)
			return
		}
		if tcpConn, ok := conn.(*net.TCPConn); ok {
			_ = tcpConn.SetNoDelay(true)
			_ = tcpConn.SetKeepAlive(true)
		}
		go handleHTTPProxyConn(conn, rt)
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
		MaxIdleConns:          cfg.UpstreamMaxIdleConns,
		MaxIdleConnsPerHost:   cfg.UpstreamMaxIdlePerHost,
		MaxConnsPerHost:       cfg.UpstreamMaxConnsPerHost,
		DisableCompression:    cfg.UpstreamDisableCompress,
	}
	h2Transport, err := http2.ConfigureTransports(transport)
	if err != nil {
		return nil, fmt.Errorf("configure http2 transport: %w", err)
	}
	h2Transport.ReadIdleTimeout = time.Duration(cfg.UpstreamH2ReadIdleMS) * time.Millisecond
	h2Transport.PingTimeout = time.Duration(cfg.UpstreamH2PingTimeoutMS) * time.Millisecond

	return &http.Client{
		Transport: transport,
		Timeout:   0,
	}, nil
}

func handleSOCKSConn(conn net.Conn, rt *proxyRuntime) {
	defer conn.Close()
	peer := conn.RemoteAddr().String()
	connCtx, cancel := connectionContext(rt.cfg)
	defer cancel()

	targetHost, targetPort, err := socks5Handshake(conn)
	if err != nil {
		logf("WARN", "socks handshake failed peer=%s err=%v", peer, err)
		return
	}

	target := net.JoinHostPort(targetHost, strconv.Itoa(targetPort))
	logf("DEBUG", "socks connect peer=%s target=%s", peer, target)

	respBody, pw, err := openUpstreamTunnel(connCtx, rt, target)
	if err != nil {
		logf("WARN", "upstream request failed peer=%s target=%s err=%v", peer, target, err)
		return
	}
	defer respBody.Close()

	var wg sync.WaitGroup
	var closeConnOnce sync.Once
	closeConn := func() {
		closeConnOnce.Do(func() { _ = conn.Close() })
	}
	wg.Add(2)

	go func() {
		defer wg.Done()
		_, copyErr := copyPooled(pw, conn)
		_ = pw.CloseWithError(copyErr)
		cancel()
		closeConn()
	}()

	go func() {
		defer wg.Done()
		_, _ = copyPooled(conn, respBody)
		cancel()
		closeConn()
	}()

	wg.Wait()
}

func handleHTTPProxyConn(conn net.Conn, rt *proxyRuntime) {
	defer conn.Close()
	peer := conn.RemoteAddr().String()
	connCtx, cancel := connectionContext(rt.cfg)
	defer cancel()
	reader := bufio.NewReader(conn)

	for {
		req, err := http.ReadRequest(reader)
		if err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, net.ErrClosed) || connCtx.Err() != nil {
				return
			}
			logf("WARN", "http proxy read request failed peer=%s err=%v", peer, err)
			return
		}
		if req.Body == nil {
			req.Body = http.NoBody
		}

		if strings.EqualFold(req.Method, http.MethodConnect) {
			target := req.Host
			if !strings.Contains(target, ":") {
				target = target + ":443"
			}
			logf("DEBUG", "http proxy connect peer=%s target=%s", peer, target)

			respBody, pw, err := openUpstreamTunnel(connCtx, rt, target)
			_ = req.Body.Close()
			if err != nil {
				logf("WARN", "http connect upstream failed peer=%s target=%s err=%v", peer, target, err)
				_, _ = conn.Write([]byte("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n"))
				return
			}
			defer respBody.Close()
			_, _ = conn.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))

			var wg sync.WaitGroup
			var closeConnOnce sync.Once
			closeConn := func() {
				closeConnOnce.Do(func() { _ = conn.Close() })
			}
			wg.Add(2)
			go func() {
				defer wg.Done()
				_, copyErr := copyPooled(pw, reader)
				_ = pw.CloseWithError(copyErr)
				cancel()
				closeConn()
			}()
			go func() {
				defer wg.Done()
				_, _ = copyPooled(conn, respBody)
				cancel()
				closeConn()
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

		respBody, pw, err := openUpstreamTunnel(connCtx, rt, target)
		if err != nil {
			_ = req.Body.Close()
			logf("WARN", "http request upstream failed peer=%s target=%s err=%v", peer, target, err)
			_, _ = conn.Write([]byte("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n"))
			return
		}

		// Proxy request uses absolute URL form, convert to origin form before forwarding to target server.
		req.URL.Scheme = ""
		req.URL.Host = ""
		req.RequestURI = ""
		writeErr := req.Write(pw)
		_ = req.Body.Close()
		if writeErr != nil {
			_ = pw.CloseWithError(writeErr)
			_ = respBody.Close()
			logf("WARN", "http request write upstream failed peer=%s target=%s err=%v", peer, target, writeErr)
			return
		}
		_ = pw.Close()
		_, _ = copyPooled(conn, respBody)
		_ = respBody.Close()

		if req.Close {
			return
		}
	}
}

func openUpstreamTunnel(ctx context.Context, rt *proxyRuntime, target string) (io.ReadCloser, writeCloserWithErr, error) {
	host, portStr, splitErr := net.SplitHostPort(target)
	if splitErr != nil {
		return nil, nil, splitErr
	}
	pr, pw := io.Pipe()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, rt.upstreamURL, pr)
	if err != nil {
		_ = pw.Close()
		return nil, nil, err
	}
	req.Header.Set("x-auth-token", rt.authToken)
	req.Header.Set("x-client-instance-id", rt.clientID)
	req.Header.Set("x-target-host", host)
	req.Header.Set("x-target-port", portStr)
	req.Header.Set("x-target", base64.RawURLEncoding.EncodeToString([]byte(target)))

	resp, err := rt.client.Do(req)
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

func connectionContext(cfg *Config) (context.Context, context.CancelFunc) {
	timeout := time.Duration(cfg.IdleTimeoutMS) * time.Millisecond
	if timeout > 0 {
		return context.WithTimeout(context.Background(), timeout)
	}
	return context.WithCancel(context.Background())
}

func resolveClientInstanceID(cfg *Config) string {
	if cfg == nil {
		return "cli-unknown"
	}
	if id := strings.TrimSpace(cfg.ClientInstanceID); id != "" {
		return id
	}
	hostname, err := os.Hostname()
	if err != nil || strings.TrimSpace(hostname) == "" {
		hostname = "unknown-host"
	}
	source := strings.Join([]string{
		hostname,
		strings.TrimSpace(cfg.UpstreamHost),
		strings.TrimSpace(cfg.SocksListen),
		strings.TrimSpace(cfg.HTTPListen),
	}, "|")
	sum := sha256.Sum256([]byte(source))
	return "cli-" + hex.EncodeToString(sum[:8])
}

func copyPooled(dst io.Writer, src io.Reader) (int64, error) {
	bufPtr := copyBufferPool.Get().(*[]byte)
	defer copyBufferPool.Put(bufPtr)
	return io.CopyBuffer(dst, src, *bufPtr)
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
	outRaw, err := cmd.CombinedOutput()
	out := decodeCommandOutput(outRaw)
	if err != nil {
		logf("ERROR", "exec failed: %s %s output=%s", name, strings.Join(args, " "), strings.TrimSpace(out))
		return out, fmt.Errorf("%s %v failed: %w, output=%s", name, args, err, strings.TrimSpace(out))
	}
	if len(strings.TrimSpace(out)) > 0 {
		logf("DEBUG", "exec output: %s", strings.TrimSpace(out))
	}
	return out, nil
}

func decodeCommandOutput(raw []byte) string {
	if len(raw) == 0 {
		return ""
	}
	if utf8.Valid(raw) {
		return string(raw)
	}
	if utf16Text, ok := tryDecodeUTF16(raw); ok {
		return utf16Text
	}
	if runtime.GOOS == "windows" {
		if gbkText, err := simplifiedchinese.GBK.NewDecoder().Bytes(raw); err == nil && utf8.Valid(gbkText) {
			return string(gbkText)
		}
	}
	return string(bytes.ToValidUTF8(raw, []byte("�")))
}

func tryDecodeUTF16(raw []byte) (string, bool) {
	if len(raw) < 2 || len(raw)%2 != 0 {
		return "", false
	}
	le := bytes.HasPrefix(raw, []byte{0xff, 0xfe})
	be := bytes.HasPrefix(raw, []byte{0xfe, 0xff})
	if !le && !be {
		return "", false
	}
	words := make([]uint16, 0, len(raw)/2)
	start := 0
	if le || be {
		start = 2
	}
	for i := start; i+1 < len(raw); i += 2 {
		if le {
			words = append(words, binary.LittleEndian.Uint16(raw[i:i+2]))
		} else {
			words = append(words, binary.BigEndian.Uint16(raw[i:i+2]))
		}
	}
	return string(utf16.Decode(words)), true
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
