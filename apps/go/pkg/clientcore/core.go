package clientcore

import (
	"bufio"
	"bytes"
	"context"
	cryptorand "crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"golang.org/x/net/http2"
	"golang.org/x/text/encoding/simplifiedchinese"
)

type Config struct {
	SocksListen                string `json:"socks_listen"`
	HTTPListen                 string `json:"http_listen"`
	UpstreamHost               string `json:"upstream_host"`
	UpstreamPort               int    `json:"upstream_port"`
	UpstreamPath               string `json:"upstream_path"`
	ServerName                 string `json:"server_name"`
	AuthToken                  string `json:"auth_token"`
	RejectUnauthorized         bool   `json:"reject_unauthorized"`
	CAFile                     string `json:"ca_file"`
	UpstreamConnectTimeoutMS   int    `json:"upstream_connect_timeout_ms"`
	ResponseHeaderTimeoutMS    int    `json:"response_header_timeout_ms"`
	IdleTimeoutMS              int    `json:"idle_timeout_ms"`
	LogLevel                   string `json:"log_level"`
	UpstreamMaxIdleConns       int    `json:"upstream_max_idle_conns"`
	UpstreamMaxIdlePerHost     int    `json:"upstream_max_idle_conns_per_host"`
	UpstreamMaxConnsPerHost    int    `json:"upstream_max_conns_per_host"`
	UpstreamDisableCompress    bool   `json:"upstream_disable_compression"`
	UpstreamH2ReadIdleMS       int    `json:"upstream_h2_read_idle_timeout_ms"`
	UpstreamH2PingTimeoutMS    int    `json:"upstream_h2_ping_timeout_ms"`
	SessionHeartbeatIntervalMS int    `json:"session_heartbeat_interval_ms"`
	DeviceID                   string `json:"device_id"`
	DeviceTicket               string `json:"device_ticket"`
}

type proxyRuntime struct {
	cfg          *Config
	client       *http.Client
	upstreamURL  string
	authToken    string
	mu           sync.RWMutex
	deviceID     string
	deviceTicket string
}

type MuxRuntimeStats struct {
	ReconnectTotal   uint64 `json:"reconnectTotal"`
	LastReconnectErr string `json:"lastReconnectErr"`
	Connected        bool   `json:"connected"`
}

type ControlResult struct {
	OK               bool   `json:"ok"`
	Error            string `json:"error,omitempty"`
	NextDeviceTicket string `json:"nextDeviceTicket,omitempty"`
}

type SessionStatusResult struct {
	OK            bool   `json:"ok"`
	Error         string `json:"error,omitempty"`
	ExpireAt      string `json:"expireAt,omitempty"`
	RemainingDays int    `json:"remainingDays"`
	Expired       bool   `json:"expired"`
	ServerTime    string `json:"serverTime,omitempty"`
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
	traceSeq  atomic.Uint64
	logSinkMu sync.RWMutex
	logSink   func(string)
)

const upstreamEstablishWarnThresholdMS = 1500
const sessionHeartbeatInterval = 30 * time.Second
const minSessionHeartbeatInterval = 5 * time.Second

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
  "session_heartbeat_interval_ms": 30000,
  "device_ticket": "",
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

func setClientAuthHeaders(headers http.Header, authToken string, deviceID string, deviceTicket string) {
	headers.Set("x-auth-token", authToken)
	if id := strings.TrimSpace(deviceID); id != "" {
		headers.Set("x-device-id", id)
	}
	if ticket := strings.TrimSpace(deviceTicket); ticket != "" {
		headers.Set("x-device-ticket", ticket)
	}
}

func ensureRuntimeDeviceID(cfg *Config) string {
	if cfg == nil {
		return ""
	}
	if id := strings.TrimSpace(cfg.DeviceID); id != "" {
		return id
	}
	buf := make([]byte, 16)
	if _, err := io.ReadFull(cryptorand.Reader, buf); err != nil {
		buf = []byte(strconv.FormatInt(time.Now().UnixNano(), 16))
	}
	cfg.DeviceID = "go-" + hex.EncodeToString(buf)
	return cfg.DeviceID
}

func ConnectProbe(cfg *Config, targetHost string, targetPort int) ControlResult {
	if cfg == nil {
		return ControlResult{OK: false, Error: "nil config"}
	}
	if strings.TrimSpace(targetHost) == "" {
		return ControlResult{OK: false, Error: "empty target host"}
	}
	if targetPort <= 0 || targetPort > 65535 {
		return ControlResult{OK: false, Error: "invalid target port"}
	}
	client, err := newHTTPClient(cfg)
	if err != nil {
		return ControlResult{OK: false, Error: err.Error()}
	}
	upstreamPath := strings.TrimSpace(cfg.UpstreamPath)
	if upstreamPath == "" {
		upstreamPath = "/proxy"
	}
	if !strings.HasPrefix(upstreamPath, "/") {
		upstreamPath = "/" + upstreamPath
	}
	url := fmt.Sprintf("https://%s:%d%s", cfg.UpstreamHost, cfg.UpstreamPort, upstreamPath)
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(cfg.ResponseHeaderTimeoutMS)*time.Millisecond)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, http.NoBody)
	if err != nil {
		return ControlResult{OK: false, Error: err.Error()}
	}
	setClientAuthHeaders(req.Header, cfg.AuthToken, ensureRuntimeDeviceID(cfg), cfg.DeviceTicket)
	req.Header.Set("x-target-host", strings.TrimSpace(targetHost))
	req.Header.Set("x-target-port", strconv.Itoa(targetPort))
	resp, err := client.Do(req)
	if err != nil {
		return ControlResult{OK: false, Error: err.Error()}
	}
	defer resp.Body.Close()
	nextTicket := strings.TrimSpace(resp.Header.Get("x-device-ticket"))
	if resp.StatusCode != http.StatusOK {
		authReason := strings.TrimSpace(resp.Header.Get("x-auth-reason"))
		if authReason != "" {
			return ControlResult{
				OK:               false,
				Error:            fmt.Sprintf("status=%d auth_reason=%s", resp.StatusCode, authReason),
				NextDeviceTicket: nextTicket,
			}
		}
		return ControlResult{
			OK:               false,
			Error:            fmt.Sprintf("status=%d", resp.StatusCode),
			NextDeviceTicket: nextTicket,
		}
	}
	return ControlResult{OK: true, NextDeviceTicket: nextTicket}
}

func SendOffline(cfg *Config) ControlResult {
	if cfg == nil {
		return ControlResult{OK: false, Error: "nil config"}
	}
	ticket := strings.TrimSpace(cfg.DeviceTicket)
	if ticket == "" {
		return ControlResult{OK: true}
	}
	client, err := newHTTPClient(cfg)
	if err != nil {
		return ControlResult{OK: false, Error: err.Error()}
	}
	url := fmt.Sprintf("https://%s:%d/session/offline", cfg.UpstreamHost, cfg.UpstreamPort)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, http.NoBody)
	if err != nil {
		return ControlResult{OK: false, Error: err.Error()}
	}
	setClientAuthHeaders(req.Header, cfg.AuthToken, ensureRuntimeDeviceID(cfg), ticket)
	resp, err := client.Do(req)
	if err != nil {
		return ControlResult{OK: false, Error: err.Error()}
	}
	defer resp.Body.Close()
	nextTicket := strings.TrimSpace(resp.Header.Get("x-device-ticket"))
	if resp.StatusCode != http.StatusOK {
		return ControlResult{
			OK:               false,
			Error:            fmt.Sprintf("status=%d", resp.StatusCode),
			NextDeviceTicket: nextTicket,
		}
	}
	return ControlResult{OK: true, NextDeviceTicket: nextTicket}
}

func GetSessionStatus(cfg *Config) SessionStatusResult {
	if cfg == nil {
		return SessionStatusResult{OK: false, Error: "nil config"}
	}
	client, err := newHTTPClient(cfg)
	if err != nil {
		return SessionStatusResult{OK: false, Error: err.Error()}
	}
	url := fmt.Sprintf("https://%s:%d/session/status", cfg.UpstreamHost, cfg.UpstreamPort)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, http.NoBody)
	if err != nil {
		return SessionStatusResult{OK: false, Error: err.Error()}
	}
	setClientAuthHeaders(req.Header, cfg.AuthToken, ensureRuntimeDeviceID(cfg), cfg.DeviceTicket)
	resp, err := client.Do(req)
	if err != nil {
		return SessionStatusResult{OK: false, Error: err.Error()}
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		authReason := strings.TrimSpace(resp.Header.Get("x-auth-reason"))
		if authReason != "" {
			return SessionStatusResult{
				OK:    false,
				Error: fmt.Sprintf("status=%d auth_reason=%s", resp.StatusCode, authReason),
			}
		}
		return SessionStatusResult{
			OK:    false,
			Error: fmt.Sprintf("status=%d", resp.StatusCode),
		}
	}
	var payload struct {
		OK            bool   `json:"ok"`
		ExpireAt      string `json:"expireAt"`
		RemainingDays int    `json:"remainingDays"`
		Expired       bool   `json:"expired"`
		ServerTime    string `json:"serverTime"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return SessionStatusResult{OK: false, Error: err.Error()}
	}
	return SessionStatusResult{
		OK:            payload.OK,
		ExpireAt:      strings.TrimSpace(payload.ExpireAt),
		RemainingDays: payload.RemainingDays,
		Expired:       payload.Expired,
		ServerTime:    strings.TrimSpace(payload.ServerTime),
	}
}

func RunProxyWithContext(ctx context.Context, cfg *Config) error {
	client, err := newHTTPClient(cfg)
	if err != nil {
		return err
	}
	rt := &proxyRuntime{
		cfg:          cfg,
		client:       client,
		upstreamURL:  fmt.Sprintf("https://%s:%d%s", cfg.UpstreamHost, cfg.UpstreamPort, cfg.UpstreamPath),
		authToken:    cfg.AuthToken,
		deviceID:     ensureRuntimeDeviceID(cfg),
		deviceTicket: strings.TrimSpace(cfg.DeviceTicket),
	}
	defer rt.sendOfflineSignal()

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
	go rt.runHeartbeatLoop(ctx)
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

func (rt *proxyRuntime) runHeartbeatLoop(ctx context.Context) {
	failures := 0
	_ = rt.sendHeartbeat(ctx)
	wait := rt.nextHeartbeatWait(failures)
	timer := time.NewTimer(wait)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			if rt.sendHeartbeat(ctx) {
				failures = 0
			} else if failures < 6 {
				failures++
			}
			timer.Reset(rt.nextHeartbeatWait(failures))
		}
	}
}

func (rt *proxyRuntime) heartbeatBaseInterval() time.Duration {
	if rt == nil || rt.cfg == nil {
		return sessionHeartbeatInterval
	}
	if rt.cfg.SessionHeartbeatIntervalMS <= 0 {
		return sessionHeartbeatInterval
	}
	interval := time.Duration(rt.cfg.SessionHeartbeatIntervalMS) * time.Millisecond
	if interval < minSessionHeartbeatInterval {
		return minSessionHeartbeatInterval
	}
	return interval
}

func (rt *proxyRuntime) nextHeartbeatWait(failures int) time.Duration {
	base := rt.heartbeatBaseInterval()
	backoff := base
	if failures > 0 {
		shift := failures
		if shift > 4 {
			shift = 4
		}
		backoff = base << shift
		if backoff > 2*time.Minute {
			backoff = 2 * time.Minute
		}
	}
	jitterMax := backoff / 5
	if jitterMax < 500*time.Millisecond {
		jitterMax = 500 * time.Millisecond
	}
	delta := time.Duration(rand.Int63n(int64(jitterMax*2)+1)) - jitterMax
	next := backoff + delta
	if next < minSessionHeartbeatInterval {
		return minSessionHeartbeatInterval
	}
	return next
}

func (rt *proxyRuntime) sendHeartbeat(parent context.Context) bool {
	pingURL := fmt.Sprintf("https://%s:%d/session/ping", rt.cfg.UpstreamHost, rt.cfg.UpstreamPort)
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, pingURL, http.NoBody)
	if err != nil {
		logf("WARN", "build heartbeat request failed err=%v", err)
		return false
	}
	setClientAuthHeaders(req.Header, rt.authToken, rt.deviceID, rt.getDeviceTicket())

	resp, err := rt.client.Do(req)
	if err != nil {
		if errors.Is(ctx.Err(), context.Canceled) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return false
		}
		logf("WARN", "heartbeat failed err=%v", err)
		return false
	}
	defer resp.Body.Close()
	if nextTicket := strings.TrimSpace(resp.Header.Get("x-device-ticket")); nextTicket != "" {
		if rt.updateDeviceTicket(nextTicket) {
			logf("INFO", "device ticket updated from heartbeat response")
		}
	}
	if resp.StatusCode != http.StatusOK {
		authReason := strings.TrimSpace(resp.Header.Get("x-auth-reason"))
		if resp.StatusCode == http.StatusUnauthorized && authReason == "invalid_device_ticket" {
			if rt.clearDeviceTicket() {
				logf("INFO", "device ticket cleared due to invalid heartbeat ticket")
			}
			return false
		}
		if authReason != "" {
			logf("WARN", "heartbeat rejected status=%d auth_reason=%s", resp.StatusCode, authReason)
			return false
		}
		logf("WARN", "heartbeat rejected status=%d", resp.StatusCode)
		return false
	}
	return true
}

func (rt *proxyRuntime) sendOfflineSignal() {
	ticket := rt.getDeviceTicket()
	if ticket == "" {
		return
	}
	offlineURL := fmt.Sprintf("https://%s:%d/session/offline", rt.cfg.UpstreamHost, rt.cfg.UpstreamPort)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, offlineURL, nil)
	if err != nil {
		logf("WARN", "build offline request failed err=%v", err)
		return
	}
	setClientAuthHeaders(req.Header, rt.authToken, rt.deviceID, ticket)

	resp, err := rt.client.Do(req)
	if err != nil {
		logf("WARN", "offline signal failed err=%v", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		logf("WARN", "offline signal rejected status=%d", resp.StatusCode)
		return
	}
	logf("INFO", "offline signal sent")
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

type socks5Request struct {
	command byte
	host    string
	port    int
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

func deviceIDSidecarPath(configPath string) string {
	base := filepath.Base(configPath)
	return filepath.Join(filepath.Dir(configPath), "."+base+".device_id")
}

func readOrCreateDeviceID(configPath string) string {
	sidecarPath := deviceIDSidecarPath(configPath)
	if data, err := os.ReadFile(sidecarPath); err == nil {
		if id := strings.TrimSpace(string(data)); id != "" {
			return id
		}
	}
	buf := make([]byte, 16)
	if _, err := io.ReadFull(cryptorand.Reader, buf); err != nil {
		buf = []byte(strconv.FormatInt(time.Now().UnixNano(), 16))
	}
	id := "go-" + hex.EncodeToString(buf)
	_ = os.WriteFile(sidecarPath, []byte(id+"\n"), 0o600)
	return id
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
	if cfg.SessionHeartbeatIntervalMS <= 0 {
		cfg.SessionHeartbeatIntervalMS = int((30 * time.Second) / time.Millisecond)
	}
	if time.Duration(cfg.SessionHeartbeatIntervalMS)*time.Millisecond < minSessionHeartbeatInterval {
		cfg.SessionHeartbeatIntervalMS = int(minSessionHeartbeatInterval / time.Millisecond)
	}
	if strings.TrimSpace(cfg.DeviceID) == "" {
		cfg.DeviceID = readOrCreateDeviceID(path)
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
	req, err := socks5Handshake(conn)
	if err != nil {
		logf("WARN", "socks handshake failed peer=%s err=%v", peer, err)
		return
	}

	if req.command == 0x03 {
		handleSOCKSUDPAssociate(conn, rt, peer)
		return
	}

	connCtx, cancel := connectionContext(rt.cfg)
	defer cancel()

	target := net.JoinHostPort(req.host, strconv.Itoa(req.port))
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

func (rt *proxyRuntime) getDeviceTicket() string {
	rt.mu.RLock()
	defer rt.mu.RUnlock()
	return strings.TrimSpace(rt.deviceTicket)
}

func (rt *proxyRuntime) updateDeviceTicket(next string) bool {
	value := strings.TrimSpace(next)
	if value == "" {
		return false
	}
	rt.mu.Lock()
	defer rt.mu.Unlock()
	if rt.deviceTicket == value {
		return false
	}
	rt.deviceTicket = value
	return true
}

func (rt *proxyRuntime) clearDeviceTicket() bool {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	if strings.TrimSpace(rt.deviceTicket) == "" {
		return false
	}
	rt.deviceTicket = ""
	return true
}

func openUpstreamTunnel(ctx context.Context, rt *proxyRuntime, target string) (io.ReadCloser, writeCloserWithErr, error) {
	host, portStr, splitErr := net.SplitHostPort(target)
	if splitErr != nil {
		return nil, nil, splitErr
	}
	startAt := time.Now()
	traceID := nextTraceID()
	originalTicket := strings.TrimSpace(rt.getDeviceTicket())

	for attempt := 0; attempt < 2; attempt++ {
		pr, pw := io.Pipe()

		req, err := http.NewRequestWithContext(ctx, http.MethodPost, rt.upstreamURL, pr)
		if err != nil {
			_ = pw.Close()
			return nil, nil, err
		}
		ticket := ""
		if attempt == 0 {
			ticket = originalTicket
		}
		setClientAuthHeaders(req.Header, rt.authToken, rt.deviceID, ticket)
		req.Header.Set("x-target-host", host)
		req.Header.Set("x-target-port", portStr)
		req.Header.Set("x-trace-id", traceID)

		resp, err := rt.client.Do(req)
		if err != nil {
			_ = pw.CloseWithError(err)
			elapsedMS := time.Since(startAt).Milliseconds()
			logf("WARN", "upstream establish failed trace_id=%s target=%s elapsed_ms=%d err=%v", traceID, target, elapsedMS, err)
			return nil, nil, err
		}
		elapsedMS := time.Since(startAt).Milliseconds()
		if elapsedMS >= upstreamEstablishWarnThresholdMS {
			logf("WARN", "slow upstream establish trace_id=%s target=%s elapsed_ms=%d threshold_ms=%d", traceID, target, elapsedMS, upstreamEstablishWarnThresholdMS)
		}
		if resp.StatusCode != http.StatusOK {
			_ = pw.CloseWithError(fmt.Errorf("status=%d", resp.StatusCode))
			authReason := strings.TrimSpace(resp.Header.Get("x-auth-reason"))
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusUnauthorized && attempt == 0 && originalTicket != "" && authReason == "invalid_device_ticket" {
				if rt.clearDeviceTicket() {
					logf("INFO", "device ticket cleared due to invalid ticket, retrying without ticket")
				}
				continue
			}
			if authReason != "" {
				logf("WARN", "upstream rejected trace_id=%s target=%s status=%d auth_reason=%s elapsed_ms=%d", traceID, target, resp.StatusCode, authReason, elapsedMS)
				return nil, nil, fmt.Errorf("upstream status=%d auth_reason=%s", resp.StatusCode, authReason)
			}
			logf("WARN", "upstream rejected trace_id=%s target=%s status=%d elapsed_ms=%d", traceID, target, resp.StatusCode, elapsedMS)
			return nil, nil, fmt.Errorf("upstream status=%d", resp.StatusCode)
		}
		if nextTicket := strings.TrimSpace(resp.Header.Get("x-device-ticket")); nextTicket != "" {
			if rt.updateDeviceTicket(nextTicket) {
				logf("INFO", "device ticket updated from upstream response")
			}
		}
		return resp.Body, pw, nil
	}
	return nil, nil, fmt.Errorf("upstream rejected: invalid device ticket")
}

func nextTraceID() string {
	seq := traceSeq.Add(1)
	now := time.Now().UnixNano()
	return fmt.Sprintf("cli-%x-%x", uint64(now), seq)
}

func connectionContext(cfg *Config) (context.Context, context.CancelFunc) {
	timeout := time.Duration(cfg.IdleTimeoutMS) * time.Millisecond
	if timeout > 0 {
		return context.WithTimeout(context.Background(), timeout)
	}
	return context.WithCancel(context.Background())
}

func copyPooled(dst io.Writer, src io.Reader) (int64, error) {
	bufPtr := copyBufferPool.Get().(*[]byte)
	defer copyBufferPool.Put(bufPtr)
	return io.CopyBuffer(dst, src, *bufPtr)
}

func handleSOCKSUDPAssociate(conn net.Conn, rt *proxyRuntime, peer string) {
	udpLn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 0})
	if err != nil {
		logf("WARN", "socks udp associate listen failed peer=%s err=%v", peer, err)
		return
	}
	defer udpLn.Close()

	localAddr, _ := udpLn.LocalAddr().(*net.UDPAddr)
	if localAddr == nil {
		logf("WARN", "socks udp associate invalid local addr peer=%s", peer)
		return
	}
	if err := writeSOCKS5Reply(conn, 0x00, localAddr.IP, localAddr.Port); err != nil {
		logf("WARN", "socks udp associate reply failed peer=%s err=%v", peer, err)
		return
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = io.Copy(io.Discard, conn)
	}()

	var clientAddr *net.UDPAddr
	buf := make([]byte, 64*1024)
	for {
		_ = udpLn.SetReadDeadline(time.Now().Add(1 * time.Second))
		n, addr, err := udpLn.ReadFromUDP(buf)
		if err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				select {
				case <-done:
					return
				default:
					continue
				}
			}
			logf("WARN", "socks udp associate read failed peer=%s err=%v", peer, err)
			return
		}
		if clientAddr == nil {
			clientAddr = addr
		} else if !addr.IP.Equal(clientAddr.IP) || addr.Port != clientAddr.Port {
			continue
		}

		targetHost, targetPort, payload, err := parseSOCKS5UDPDatagram(buf[:n])
		if err != nil {
			continue
		}
		if targetPort != 53 {
			continue
		}
		respPayload, err := proxyDNSOverTCP(rt, targetHost, targetPort, payload)
		if err != nil {
			logf("WARN", "dns relay failed peer=%s target=%s:%d err=%v", peer, targetHost, targetPort, err)
			continue
		}
		packet, err := buildSOCKS5UDPDatagram(targetHost, targetPort, respPayload)
		if err != nil {
			logf("WARN", "dns relay response encode failed peer=%s target=%s:%d err=%v", peer, targetHost, targetPort, err)
			continue
		}
		_, _ = udpLn.WriteToUDP(packet, clientAddr)
	}
}

func proxyDNSOverTCP(rt *proxyRuntime, targetHost string, targetPort int, payload []byte) ([]byte, error) {
	if len(payload) == 0 {
		return nil, errors.New("empty dns payload")
	}
	if len(payload) > 0xffff {
		return nil, errors.New("dns payload too large")
	}

	target := net.JoinHostPort(targetHost, strconv.Itoa(targetPort))
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	respBody, pw, err := openUpstreamTunnel(ctx, rt, target)
	if err != nil {
		return nil, err
	}
	defer respBody.Close()

	reqLen := make([]byte, 2)
	binary.BigEndian.PutUint16(reqLen, uint16(len(payload)))
	if _, err := pw.Write(reqLen); err != nil {
		_ = pw.CloseWithError(err)
		return nil, err
	}
	if _, err := pw.Write(payload); err != nil {
		_ = pw.CloseWithError(err)
		return nil, err
	}
	if err := pw.Close(); err != nil {
		return nil, err
	}

	respLenBuf := make([]byte, 2)
	if _, err := io.ReadFull(respBody, respLenBuf); err != nil {
		return nil, err
	}
	respLen := int(binary.BigEndian.Uint16(respLenBuf))
	if respLen == 0 {
		return nil, errors.New("empty dns response")
	}
	resp := make([]byte, respLen)
	if _, err := io.ReadFull(respBody, resp); err != nil {
		return nil, err
	}
	return resp, nil
}

func parseSOCKS5UDPDatagram(packet []byte) (string, int, []byte, error) {
	if len(packet) < 10 {
		return "", 0, nil, errors.New("short udp packet")
	}
	if packet[2] != 0x00 {
		return "", 0, nil, errors.New("fragmented udp unsupported")
	}
	offset := 3
	host, next, err := parseSOCKS5Addr(packet, offset)
	if err != nil {
		return "", 0, nil, err
	}
	offset = next
	if len(packet) < offset+2 {
		return "", 0, nil, errors.New("udp packet missing port")
	}
	port := int(binary.BigEndian.Uint16(packet[offset : offset+2]))
	offset += 2
	payload := make([]byte, len(packet[offset:]))
	copy(payload, packet[offset:])
	return host, port, payload, nil
}

func buildSOCKS5UDPDatagram(host string, port int, payload []byte) ([]byte, error) {
	addr, err := encodeSOCKS5Addr(host)
	if err != nil {
		return nil, err
	}
	packet := make([]byte, 0, 3+len(addr)+2+len(payload))
	packet = append(packet, 0x00, 0x00, 0x00)
	packet = append(packet, addr...)
	portBuf := make([]byte, 2)
	binary.BigEndian.PutUint16(portBuf, uint16(port))
	packet = append(packet, portBuf...)
	packet = append(packet, payload...)
	return packet, nil
}

func parseSOCKS5Addr(buf []byte, offset int) (string, int, error) {
	if len(buf) <= offset {
		return "", 0, errors.New("missing atyp")
	}
	atyp := buf[offset]
	offset++
	switch atyp {
	case 0x01:
		if len(buf) < offset+4 {
			return "", 0, errors.New("short ipv4 address")
		}
		return net.IP(buf[offset : offset+4]).String(), offset + 4, nil
	case 0x03:
		if len(buf) <= offset {
			return "", 0, errors.New("short domain length")
		}
		n := int(buf[offset])
		offset++
		if len(buf) < offset+n {
			return "", 0, errors.New("short domain address")
		}
		return string(buf[offset : offset+n]), offset + n, nil
	case 0x04:
		if len(buf) < offset+16 {
			return "", 0, errors.New("short ipv6 address")
		}
		return net.IP(buf[offset : offset+16]).String(), offset + 16, nil
	default:
		return "", 0, errors.New("unsupported atyp")
	}
}

func encodeSOCKS5Addr(host string) ([]byte, error) {
	if ip := net.ParseIP(host); ip != nil {
		if ipv4 := ip.To4(); ipv4 != nil {
			return append([]byte{0x01}, ipv4...), nil
		}
		if ipv6 := ip.To16(); ipv6 != nil {
			return append([]byte{0x04}, ipv6...), nil
		}
	}
	if len(host) == 0 || len(host) > 255 {
		return nil, errors.New("invalid domain length")
	}
	return append([]byte{0x03, byte(len(host))}, []byte(host)...), nil
}

func writeSOCKS5Reply(conn net.Conn, rep byte, ip net.IP, port int) error {
	addr := net.IPv4zero
	if ipv4 := ip.To4(); ipv4 != nil {
		addr = ipv4
	}
	reply := []byte{0x05, rep, 0x00, 0x01, addr[0], addr[1], addr[2], addr[3], 0, 0}
	binary.BigEndian.PutUint16(reply[8:], uint16(port))
	_, err := conn.Write(reply)
	return err
}

func socks5Handshake(conn net.Conn) (socks5Request, error) {
	reader := bufio.NewReader(conn)

	head := make([]byte, 2)
	if _, err := io.ReadFull(reader, head); err != nil {
		return socks5Request{}, err
	}
	if head[0] != 0x05 {
		return socks5Request{}, errors.New("only socks5")
	}

	methodN := int(head[1])
	methods := make([]byte, methodN)
	if _, err := io.ReadFull(reader, methods); err != nil {
		return socks5Request{}, err
	}

	_, _ = conn.Write([]byte{0x05, 0x00}) // no auth

	reqHead := make([]byte, 4)
	if _, err := io.ReadFull(reader, reqHead); err != nil {
		return socks5Request{}, err
	}
	if reqHead[0] != 0x05 {
		_ = writeSOCKS5Reply(conn, 0x01, net.IPv4zero, 0)
		return socks5Request{}, errors.New("invalid request version")
	}
	if reqHead[1] != 0x01 && reqHead[1] != 0x03 {
		_ = writeSOCKS5Reply(conn, 0x07, net.IPv4zero, 0)
		return socks5Request{}, errors.New("only connect or udp associate command")
	}

	addrBuf := append([]byte{reqHead[3]}, []byte{}...)
	switch reqHead[3] {
	case 0x01:
		tmp := make([]byte, 4)
		if _, err := io.ReadFull(reader, tmp); err != nil {
			return socks5Request{}, err
		}
		addrBuf = append(addrBuf, tmp...)
	case 0x03:
		lenBuf := make([]byte, 1)
		if _, err := io.ReadFull(reader, lenBuf); err != nil {
			return socks5Request{}, err
		}
		addrBuf = append(addrBuf, lenBuf[0])
		tmp := make([]byte, int(lenBuf[0]))
		if _, err := io.ReadFull(reader, tmp); err != nil {
			return socks5Request{}, err
		}
		addrBuf = append(addrBuf, tmp...)
	case 0x04:
		tmp := make([]byte, 16)
		if _, err := io.ReadFull(reader, tmp); err != nil {
			return socks5Request{}, err
		}
		addrBuf = append(addrBuf, tmp...)
	default:
		return socks5Request{}, errors.New("unsupported atyp")
	}
	host, _, err := parseSOCKS5Addr(addrBuf, 0)
	if err != nil {
		return socks5Request{}, err
	}

	portBuf := make([]byte, 2)
	if _, err := io.ReadFull(reader, portBuf); err != nil {
		return socks5Request{}, err
	}
	port := int(portBuf[0])<<8 | int(portBuf[1])

	if reqHead[1] == 0x01 {
		_ = writeSOCKS5Reply(conn, 0x00, net.IPv4zero, 0)
	}
	return socks5Request{
		command: reqHead[1],
		host:    host,
		port:    port,
	}, nil
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
	line := fmt.Sprintf("[go-client][%s][%s] %s", time.Now().UTC().Format(time.RFC3339), l, msg)
	log.Print(line)
	logSinkMu.RLock()
	sink := logSink
	logSinkMu.RUnlock()
	if sink != nil {
		sink(line)
	}
}

// SetLogSink sets an optional callback to receive runtime log lines.
// Passing nil disables sink forwarding.
func SetLogSink(sink func(string)) {
	logSinkMu.Lock()
	logSink = sink
	logSinkMu.Unlock()
}
