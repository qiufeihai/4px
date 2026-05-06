package clientcore

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
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
	"sync/atomic"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"golang.org/x/net/http2"
	"golang.org/x/text/encoding/simplifiedchinese"
)

type Config struct {
	SocksListen                 string `json:"socks_listen"`
	HTTPListen                  string `json:"http_listen"`
	UpstreamHost                string `json:"upstream_host"`
	UpstreamPort                int    `json:"upstream_port"`
	UpstreamPath                string `json:"upstream_path"`
	ServerName                  string `json:"server_name"`
	AuthToken                   string `json:"auth_token"`
	RejectUnauthorized          bool   `json:"reject_unauthorized"`
	CAFile                      string `json:"ca_file"`
	UpstreamConnectTimeoutMS    int    `json:"upstream_connect_timeout_ms"`
	ResponseHeaderTimeoutMS     int    `json:"response_header_timeout_ms"`
	IdleTimeoutMS               int    `json:"idle_timeout_ms"`
	LogLevel                    string `json:"log_level"`
	UpstreamMaxIdleConns        int    `json:"upstream_max_idle_conns"`
	UpstreamMaxIdlePerHost      int    `json:"upstream_max_idle_conns_per_host"`
	UpstreamMaxConnsPerHost     int    `json:"upstream_max_conns_per_host"`
	UpstreamDisableCompress     bool   `json:"upstream_disable_compression"`
	UpstreamH2ReadIdleMS        int    `json:"upstream_h2_read_idle_timeout_ms"`
	UpstreamH2PingTimeoutMS     int    `json:"upstream_h2_ping_timeout_ms"`
	UpstreamTLSSessionCacheSize int    `json:"upstream_tls_session_cache_size"`
	MuxTuningProfile            string `json:"mux_tuning_profile"`
	MuxFlushIntervalMS          int    `json:"mux_flush_interval_ms"`
	MuxFlushNotifyBytes         int    `json:"mux_flush_notify_bytes"`
	MuxFlushBurstBytes          int    `json:"mux_flush_burst_bytes"`
	MuxFlushMaxDelayMS          int    `json:"mux_flush_max_delay_ms"`
	MuxStreamDataQueue          int    `json:"mux_stream_data_queue"`
}

type proxyRuntime struct {
	cfg         *Config
	client      *http.Client
	upstreamURL string
	authToken   string
	v2Path      bool
	mux         *muxClientRuntime
}

type MuxRuntimeStats struct {
	ReconnectTotal            uint64 `json:"reconnectTotal"`
	ReconnectConsecutiveFails uint64 `json:"reconnectConsecutiveFails"`
	LastReconnectErr          string `json:"lastReconnectErr"`
	LastReconnectClass        string `json:"lastReconnectClass"`
	LastReconnectBackoffMS    int64  `json:"lastReconnectBackoffMs"`
	Connected                 bool   `json:"connected"`
}

const (
	muxFrameOpen       byte = 1
	muxFrameData       byte = 2
	muxFrameClose      byte = 3
	muxFrameOpenResult byte = 4
	muxFrameOpenError  byte = 5

	muxWriteBufferSize = 64 * 1024

	muxReconnectBaseBackoff = 200 * time.Millisecond
	muxReconnectMaxBackoff  = 5 * time.Second
)

const (
	muxProfileLatency    = "latency"
	muxProfileBalanced   = "balanced"
	muxProfileThroughput = "throughput"
)

type muxTuning struct {
	flushInterval    time.Duration
	flushNotifyBytes int
	flushBurstBytes  int
	flushMaxDelay    time.Duration
	streamDataQueue  int
}

func defaultMuxTuningForProfile(profile string) muxTuning {
	switch normalizeMuxTuningProfile(profile) {
	case muxProfileLatency:
		return muxTuning{
			flushInterval:    1 * time.Millisecond,
			flushNotifyBytes: 2 * 1024,
			flushBurstBytes:  12 * 1024,
			flushMaxDelay:    2 * time.Millisecond,
			streamDataQueue:  8,
		}
	case muxProfileThroughput:
		return muxTuning{
			flushInterval:    4 * time.Millisecond,
			flushNotifyBytes: 8 * 1024,
			flushBurstBytes:  48 * 1024,
			flushMaxDelay:    8 * time.Millisecond,
			streamDataQueue:  16,
		}
	default:
		return muxTuning{
			flushInterval:    2 * time.Millisecond,
			flushNotifyBytes: 4 * 1024,
			flushBurstBytes:  24 * 1024,
			flushMaxDelay:    4 * time.Millisecond,
			streamDataQueue:  8,
		}
	}
}

func resolveMuxTuning(cfg *Config) muxTuning {
	t := defaultMuxTuningForProfile(cfg.MuxTuningProfile)
	if cfg.MuxFlushIntervalMS > 0 {
		t.flushInterval = time.Duration(cfg.MuxFlushIntervalMS) * time.Millisecond
	}
	if cfg.MuxFlushNotifyBytes > 0 {
		t.flushNotifyBytes = cfg.MuxFlushNotifyBytes
	}
	if cfg.MuxFlushBurstBytes > 0 {
		t.flushBurstBytes = cfg.MuxFlushBurstBytes
	}
	if cfg.MuxFlushMaxDelayMS > 0 {
		t.flushMaxDelay = time.Duration(cfg.MuxFlushMaxDelayMS) * time.Millisecond
	}
	if cfg.MuxStreamDataQueue > 0 {
		t.streamDataQueue = cfg.MuxStreamDataQueue
	}
	// Keep hard lower bounds to avoid pathological tiny/zero values.
	if t.flushInterval < 1*time.Millisecond {
		t.flushInterval = 1 * time.Millisecond
	}
	if t.flushMaxDelay < t.flushInterval {
		t.flushMaxDelay = t.flushInterval
	}
	if t.flushNotifyBytes < 1024 {
		t.flushNotifyBytes = 1024
	}
	if t.flushBurstBytes < t.flushNotifyBytes {
		t.flushBurstBytes = t.flushNotifyBytes
	}
	if t.streamDataQueue < 1 {
		t.streamDataQueue = 1
	}
	return t
}

func normalizeMuxTuningProfile(v string) string {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case muxProfileLatency:
		return muxProfileLatency
	case muxProfileThroughput:
		return muxProfileThroughput
	default:
		return muxProfileBalanced
	}
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
	muxPayloadPool = sync.Pool{
		New: func() any {
			buf := make([]byte, 0, 32*1024)
			return &buf
		},
	}
	muxStatsMu sync.Mutex
	muxStats   MuxRuntimeStats
)

const defaultClientConfigTemplate = `{
  "socks_listen": "127.0.0.1:7777",
  "http_listen": "127.0.0.1:7788",
  "upstream_host": "your-server-ip",
  "upstream_port": 6666,
  "upstream_path": "/proxy-v2",
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
  "upstream_tls_session_cache_size": 256,
  "mux_tuning_profile": "balanced",
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
		var b strings.Builder
		out, err := runOutput("reg", "query", `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`, "/v", "ProxyEnable")
		if err != nil {
			return "", err
		}
		b.WriteString(strings.TrimSpace(out) + "\n")
		out, err = runOutput("reg", "query", `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`, "/v", "ProxyServer")
		if err != nil {
			return "", err
		}
		b.WriteString(strings.TrimSpace(out) + "\n")
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
	muxStatsMu.Lock()
	defer muxStatsMu.Unlock()
	return muxStats
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
		v2Path:      cfg.UpstreamPath == "/proxy-v2",
	}
	if rt.v2Path {
		rt.mux = newMuxClient(ctx, client, rt.upstreamURL, rt.authToken, resolveMuxTuning(cfg))
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

func newMuxClient(_ context.Context, client *http.Client, upstreamURL string, authToken string, tuning muxTuning) *muxClientRuntime {
	if tuning.flushInterval <= 0 || tuning.flushNotifyBytes <= 0 || tuning.flushBurstBytes <= 0 || tuning.flushMaxDelay <= 0 || tuning.streamDataQueue <= 0 {
		tuning = defaultMuxTuningForProfile(muxProfileBalanced)
	}
	return &muxClientRuntime{
		client:      client,
		upstreamURL: upstreamURL,
		authToken:   authToken,
		tuning:      tuning,
	}
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

type muxUpstreamWriter struct {
	s *muxStream
}

func (w *muxUpstreamWriter) Write(p []byte) (int, error) {
	return w.s.Write(p)
}

func (w *muxUpstreamWriter) Close() error {
	return w.s.Close()
}

func (w *muxUpstreamWriter) CloseWithError(_ error) error {
	return w.s.Close()
}

type muxClientRuntime struct {
	client      *http.Client
	upstreamURL string
	authToken   string
	tuning      muxTuning

	mu                      sync.Mutex
	startMu                 sync.Mutex
	writeMu                 sync.Mutex
	started                 bool
	everStarted             bool
	startErr                error
	reconnectTotal          uint64
	reconnectFails          uint64
	lastReconnectErr        string
	lastReconnectClass      string
	lastReconnectBackoff    time.Duration
	nextReconnectAttempt    time.Time
	streamW                 *io.PipeWriter
	streamBW                *bufio.Writer
	streamR                 io.ReadCloser
	flushNotify             chan struct{}
	stopFlush               chan struct{}
	flushWG                 sync.WaitGroup
	pendingFlushBytes       int
	pendingFlushBytesAtomic atomic.Int64
	lastFlushAt             time.Time

	nextID  atomic.Uint32
	streams map[uint32]*muxStream
	closed  bool
}

type muxStream struct {
	id     uint32
	parent *muxClientRuntime

	pr *io.PipeReader
	pw *io.PipeWriter

	dataCh     chan streamDataChunk
	writerDone chan struct{}

	openOnce  sync.Once
	openCh    chan error
	closeOnce sync.Once
}

type streamDataChunk struct {
	data []byte
	slot *[]byte
}

func (m *muxStream) Read(p []byte) (int, error) {
	return m.pr.Read(p)
}

func (m *muxStream) Write(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	if err := m.parent.sendFrame(muxFrameData, m.id, p); err != nil {
		return 0, err
	}
	return len(p), nil
}

func (m *muxStream) Close() error {
	m.closeWithError(nil, true)
	return nil
}

func (m *muxStream) startWriter() {
	go func() {
		defer close(m.writerDone)
		for chunk := range m.dataCh {
			if len(chunk.data) == 0 {
				putMuxPayloadBuffer(chunk.slot)
				continue
			}
			if _, err := m.pw.Write(chunk.data); err != nil {
				putMuxPayloadBuffer(chunk.slot)
				for remain := range m.dataCh {
					putMuxPayloadBuffer(remain.slot)
				}
				_ = m.pw.CloseWithError(err)
				return
			}
			putMuxPayloadBuffer(chunk.slot)
		}
		_ = m.pw.Close()
	}()
}

func (m *muxStream) queueData(payload []byte) error {
	if len(payload) == 0 {
		return nil
	}
	buf, slot := getMuxPayloadBuffer(len(payload))
	copy(buf, payload)
	chunk := streamDataChunk{
		data: buf,
		slot: slot,
	}
	select {
	case m.dataCh <- chunk:
		return nil
	default:
		putMuxPayloadBuffer(slot)
		return errors.New("stream backpressure overflow")
	}
}

func (m *muxStream) closeWithError(err error, sendClose bool) {
	m.closeOnce.Do(func() {
		if sendClose {
			_ = m.parent.sendFrame(muxFrameClose, m.id, nil)
		}
		m.parent.removeStream(m.id)
		if err != nil {
			_ = m.pr.CloseWithError(err)
		} else {
			_ = m.pr.Close()
		}
		close(m.dataCh)
		<-m.writerDone
	})
}

func (m *muxStream) notifyOpen(err error) {
	m.openOnce.Do(func() {
		m.openCh <- err
		close(m.openCh)
	})
}

func (m *muxClientRuntime) Open(ctx context.Context, target string) (*muxStream, error) {
	if err := m.start(context.Background()); err != nil {
		return nil, err
	}
	id := m.nextID.Add(1)
	pr, pw := io.Pipe()
	ms := &muxStream{
		id:         id,
		parent:     m,
		pr:         pr,
		pw:         pw,
		openCh:     make(chan error, 1),
		dataCh:     make(chan streamDataChunk, m.tuning.streamDataQueue),
		writerDone: make(chan struct{}),
	}
	ms.startWriter()
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		_ = pw.CloseWithError(errors.New("mux closed"))
		_ = pr.Close()
		return nil, errors.New("mux closed")
	}
	m.streams[id] = ms
	m.mu.Unlock()

	if err := m.sendFrame(muxFrameOpen, id, []byte(target)); err != nil {
		ms.closeWithError(err, false)
		return nil, err
	}

	select {
	case err := <-ms.openCh:
		if err != nil {
			ms.closeWithError(err, false)
			return nil, err
		}
		return ms, nil
	case <-ctx.Done():
		ms.closeWithError(ctx.Err(), false)
		return nil, ctx.Err()
	}
}

func (m *muxClientRuntime) start(ctx context.Context) error {
	m.startMu.Lock()
	defer m.startMu.Unlock()

	m.mu.Lock()
	if m.started && !m.closed && m.streamW != nil && m.startErr == nil {
		err := m.startErr
		m.mu.Unlock()
		return err
	}
	isReconnectAttempt := m.everStarted
	waitUntil := m.nextReconnectAttempt
	m.started = true
	m.closed = false
	m.startErr = nil
	if m.streams == nil {
		m.streams = make(map[uint32]*muxStream)
	}
	if isReconnectAttempt {
		m.reconnectTotal++
	}
	m.everStarted = true
	m.mu.Unlock()
	if isReconnectAttempt && !waitUntil.IsZero() {
		if delay := time.Until(waitUntil); delay > 0 {
			logf("DEBUG", "mux reconnect backoff wait=%s", delay)
			select {
			case <-ctx.Done():
				m.mu.Lock()
				m.startErr = ctx.Err()
				m.started = false
				m.closed = true
				m.mu.Unlock()
				return ctx.Err()
			case <-time.After(delay):
			}
		}
	}
	m.recordStats(func(s *MuxRuntimeStats) {
		s.Connected = false
		if isReconnectAttempt {
			s.ReconnectTotal = m.reconnectTotal
		}
	})

	pr, pw := io.Pipe()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, m.upstreamURL, pr)
	if err != nil {
		_ = pw.CloseWithError(err)
		m.mu.Lock()
		m.startErr = err
		m.started = false
		m.closed = true
		m.mu.Unlock()
		m.markReconnectFailure(isReconnectAttempt, reconnectErrClass(err, "network"), err)
		return err
	}
	req.Header.Set("x-auth-token", m.authToken)
	req.Header.Set("x-4px-v2", "1")
	req.Header.Set("x-4px-v2-mode", "mux")

	resp, err := m.client.Do(req)
	if err != nil {
		_ = pw.CloseWithError(err)
		m.mu.Lock()
		m.startErr = err
		m.mu.Unlock()
		m.markReconnectFailure(isReconnectAttempt, reconnectErrClass(err, "network"), err)
		return err
	}
	if resp.StatusCode != http.StatusOK {
		_ = pw.CloseWithError(fmt.Errorf("mux status=%d", resp.StatusCode))
		_ = resp.Body.Close()
		err = fmt.Errorf("mux upstream status=%d", resp.StatusCode)
		m.mu.Lock()
		m.startErr = err
		m.started = false
		m.closed = true
		m.mu.Unlock()
		class := "network"
		if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
			class = "auth"
		}
		m.markReconnectFailure(isReconnectAttempt, class, err)
		return err
	}

	m.mu.Lock()
	m.streamW = pw
	m.streamBW = bufio.NewWriterSize(pw, muxWriteBufferSize)
	m.streamR = resp.Body
	m.flushNotify = make(chan struct{}, 1)
	m.stopFlush = make(chan struct{})
	m.pendingFlushBytes = 0
	m.pendingFlushBytesAtomic.Store(0)
	m.lastFlushAt = time.Now()
	m.lastReconnectErr = ""
	m.lastReconnectClass = ""
	m.lastReconnectBackoff = 0
	m.nextReconnectAttempt = time.Time{}
	m.reconnectFails = 0
	reconnectTotal := m.reconnectTotal
	m.mu.Unlock()
	m.startFlushLoop()
	m.recordStats(func(s *MuxRuntimeStats) {
		s.Connected = true
		if isReconnectAttempt {
			s.LastReconnectErr = ""
			s.LastReconnectClass = ""
			s.LastReconnectBackoffMS = 0
			s.ReconnectTotal = reconnectTotal
			s.ReconnectConsecutiveFails = 0
		}
	})
	if isReconnectAttempt {
		logf("INFO", "mux reconnected total=%d", m.reconnectTotalValue())
	}
	go m.readLoop()
	return nil
}

func (m *muxClientRuntime) readLoop() {
	reader := bufio.NewReader(m.streamR)
	var header [9]byte
	for {
		if _, err := io.ReadFull(reader, header[:]); err != nil {
			m.closeAll(err)
			return
		}
		frameType := header[0]
		streamID := binary.BigEndian.Uint32(header[1:5])
		payloadLen := binary.BigEndian.Uint32(header[5:9])
		payload, payloadSlot := getMuxPayloadBuffer(int(payloadLen))
		if payloadLen > 0 {
			if _, err := io.ReadFull(reader, payload); err != nil {
				putMuxPayloadBuffer(payloadSlot)
				m.closeAll(err)
				return
			}
		}
		m.dispatchFrame(frameType, streamID, payload)
		putMuxPayloadBuffer(payloadSlot)
	}
}

func (m *muxClientRuntime) dispatchFrame(frameType byte, streamID uint32, payload []byte) {
	m.mu.Lock()
	ms := m.streams[streamID]
	m.mu.Unlock()
	if ms == nil {
		return
	}
	switch frameType {
	case muxFrameOpenResult:
		ms.notifyOpen(nil)
	case muxFrameOpenError:
		msg := "open failed"
		if len(payload) > 0 {
			msg = string(payload)
		}
		ms.notifyOpen(errors.New(msg))
	case muxFrameData:
		if err := ms.queueData(payload); err != nil {
			ms.notifyOpen(err)
			ms.closeWithError(err, true)
		}
	case muxFrameClose:
		ms.notifyOpen(errors.New("stream closed"))
		ms.closeWithError(errors.New("stream closed"), false)
	}
}

func (m *muxClientRuntime) sendFrame(frameType byte, streamID uint32, payload []byte) error {
	m.mu.Lock()
	if m.closed || m.streamBW == nil {
		m.mu.Unlock()
		return errors.New("mux not ready")
	}
	w := m.streamBW
	flushNotify := m.flushNotify
	m.mu.Unlock()

	var header [9]byte
	header[0] = frameType
	binary.BigEndian.PutUint32(header[1:5], streamID)
	binary.BigEndian.PutUint32(header[5:9], uint32(len(payload)))

	m.writeMu.Lock()
	defer m.writeMu.Unlock()
	if err := writeAll(w, header[:]); err != nil {
		return err
	}
	if len(payload) == 0 {
		return m.flushBufferedLocked(w)
	}
	if err := writeAll(w, payload); err != nil {
		return err
	}
	m.pendingFlushBytes += len(header) + len(payload)
	m.pendingFlushBytesAtomic.Store(int64(m.pendingFlushBytes))
	// Control frames should be delivered promptly; data frames are batch-flushed.
	if frameType != muxFrameData {
		return m.flushBufferedLocked(w)
	}
	// Adaptive flush:
	// - high burst: flush immediately to reduce queueing delay
	// - low traffic: rely on periodic flush with lightweight notify
	if m.pendingFlushBytes >= m.tuning.flushBurstBytes || time.Since(m.lastFlushAt) >= m.tuning.flushMaxDelay {
		return m.flushBufferedLocked(w)
	}
	if flushNotify != nil && m.pendingFlushBytes >= m.tuning.flushNotifyBytes {
		select {
		case flushNotify <- struct{}{}:
		default:
		}
	}
	return nil
}

func writeAll(w io.Writer, p []byte) error {
	for len(p) > 0 {
		n, err := w.Write(p)
		if err != nil {
			return err
		}
		p = p[n:]
	}
	return nil
}

func getMuxPayloadBuffer(n int) ([]byte, *[]byte) {
	if n <= 0 {
		return nil, nil
	}
	const pooledLimit = 64 * 1024
	if n > pooledLimit {
		return make([]byte, n), nil
	}
	slot := muxPayloadPool.Get().(*[]byte)
	if cap(*slot) < n {
		*slot = make([]byte, n)
	}
	return (*slot)[:n], slot
}

func putMuxPayloadBuffer(slot *[]byte) {
	if slot == nil {
		return
	}
	*slot = (*slot)[:0]
	muxPayloadPool.Put(slot)
}

func (m *muxClientRuntime) removeStream(streamID uint32) {
	m.mu.Lock()
	delete(m.streams, streamID)
	m.mu.Unlock()
}

func (m *muxClientRuntime) closeAll(err error) {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return
	}
	m.closed = true
	m.started = false
	m.startErr = err
	streams := make([]*muxStream, 0, len(m.streams))
	for _, s := range m.streams {
		streams = append(streams, s)
	}
	m.streams = map[uint32]*muxStream{}
	w := m.streamW
	bw := m.streamBW
	r := m.streamR
	stopFlush := m.stopFlush
	m.streamW = nil
	m.streamBW = nil
	m.streamR = nil
	m.flushNotify = nil
	m.stopFlush = nil
	m.mu.Unlock()
	if stopFlush != nil {
		close(stopFlush)
		m.flushWG.Wait()
	}
	m.recordStats(func(s *MuxRuntimeStats) {
		s.Connected = false
		if err != nil {
			s.LastReconnectErr = err.Error()
		}
	})

	if err != nil {
		logf("WARN", "mux channel closed err=%v", err)
	}

	if w != nil {
		if bw != nil {
			m.writeMu.Lock()
			_ = bw.Flush()
			m.writeMu.Unlock()
		}
		_ = w.CloseWithError(err)
	}
	if r != nil {
		_ = r.Close()
	}
	for _, s := range streams {
		s.notifyOpen(err)
		s.closeWithError(err, false)
	}
}

func (m *muxClientRuntime) startFlushLoop() {
	m.mu.Lock()
	stop := m.stopFlush
	notify := m.flushNotify
	m.mu.Unlock()
	if stop == nil || notify == nil {
		return
	}
	m.flushWG.Add(1)
	go func() {
		defer m.flushWG.Done()
		ticker := time.NewTicker(m.tuning.flushInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if m.pendingFlushBytesAtomic.Load() == 0 {
					continue
				}
				_ = m.flushBuffered()
			case <-notify:
				if m.pendingFlushBytesAtomic.Load() == 0 {
					continue
				}
				// Coalesce burst notifications to avoid redundant flush wakeups.
				for {
					select {
					case <-notify:
					default:
						goto doFlush
					}
				}
			doFlush:
				_ = m.flushBuffered()
			case <-stop:
				_ = m.flushBuffered()
				return
			}
		}
	}()
}

func (m *muxClientRuntime) flushBuffered() error {
	m.mu.Lock()
	bw := m.streamBW
	m.mu.Unlock()
	if bw == nil {
		return nil
	}
	m.writeMu.Lock()
	defer m.writeMu.Unlock()
	return m.flushBufferedLocked(bw)
}

func (m *muxClientRuntime) flushBufferedLocked(bw *bufio.Writer) error {
	if bw == nil {
		return nil
	}
	if err := bw.Flush(); err != nil {
		return err
	}
	m.pendingFlushBytes = 0
	m.pendingFlushBytesAtomic.Store(0)
	m.lastFlushAt = time.Now()
	return nil
}

func (m *muxClientRuntime) recordStats(update func(*MuxRuntimeStats)) {
	muxStatsMu.Lock()
	defer muxStatsMu.Unlock()
	update(&muxStats)
}

func (m *muxClientRuntime) reconnectTotalValue() uint64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.reconnectTotal
}

func (m *muxClientRuntime) markReconnectFailure(isReconnectAttempt bool, class string, err error) {
	if !isReconnectAttempt {
		return
	}
	m.mu.Lock()
	m.reconnectFails++
	failures := m.reconnectFails
	backoff := reconnectBackoffFor(class, failures)
	m.lastReconnectErr = err.Error()
	m.lastReconnectClass = class
	m.lastReconnectBackoff = backoff
	m.nextReconnectAttempt = time.Now().Add(backoff)
	total := m.reconnectTotal
	m.mu.Unlock()

	m.recordStats(func(s *MuxRuntimeStats) {
		s.Connected = false
		s.LastReconnectErr = err.Error()
		s.LastReconnectClass = class
		s.LastReconnectBackoffMS = backoff.Milliseconds()
		s.ReconnectTotal = total
		s.ReconnectConsecutiveFails = failures
	})
	logf("WARN", "mux reconnect failed total=%d consecutive=%d class=%s backoff_ms=%d err=%v", total, failures, class, backoff.Milliseconds(), err)
}

func reconnectBackoffFor(class string, failures uint64) time.Duration {
	shift := failures - 1
	if shift > 5 {
		shift = 5
	}
	backoff := muxReconnectBaseBackoff * time.Duration(1<<shift)
	if backoff > muxReconnectMaxBackoff {
		backoff = muxReconnectMaxBackoff
	}
	if class == "auth" || class == "tls" {
		if backoff < 2*time.Second {
			backoff = 2 * time.Second
		}
	}
	return backoff
}

func reconnectErrClass(err error, fallback string) string {
	msg := strings.ToLower(err.Error())
	if strings.Contains(msg, "x509") || strings.Contains(msg, "certificate") || strings.Contains(msg, "tls") {
		return "tls"
	}
	if strings.Contains(msg, "unauthorized") || strings.Contains(msg, "forbidden") || strings.Contains(msg, "status=401") || strings.Contains(msg, "status=403") {
		return "auth"
	}
	if strings.Contains(msg, "timeout") || strings.Contains(msg, "connection refused") || strings.Contains(msg, "reset by peer") || strings.Contains(msg, "broken pipe") {
		return "network"
	}
	return fallback
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
		cfg.UpstreamPath = "/proxy-v2"
	}
	if !strings.HasPrefix(cfg.UpstreamPath, "/") {
		cfg.UpstreamPath = "/" + cfg.UpstreamPath
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
	if cfg.UpstreamTLSSessionCacheSize <= 0 {
		cfg.UpstreamTLSSessionCacheSize = 256
	}
	cfg.MuxTuningProfile = normalizeMuxTuningProfile(cfg.MuxTuningProfile)
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
		v2Path:      cfg.UpstreamPath == "/proxy-v2",
	}
	if rt.v2Path {
		rt.mux = newMuxClient(context.Background(), client, rt.upstreamURL, rt.authToken, resolveMuxTuning(cfg))
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
		ClientSessionCache: tls.NewLRUClientSessionCache(cfg.UpstreamTLSSessionCacheSize),
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
	if rt.v2Path && rt.mux != nil {
		ms, err := rt.mux.Open(ctx, target)
		if err != nil {
			return nil, nil, err
		}
		return ms, &muxUpstreamWriter{s: ms}, nil
	}
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
	req.Header.Set("x-target-host", host)
	req.Header.Set("x-target-port", portStr)
	if rt.v2Path {
		req.Header.Set("x-4px-v2", "1")
	}
	if !rt.v2Path {
		req.Header.Set("x-target", base64.RawURLEncoding.EncodeToString([]byte(target)))
	}

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
