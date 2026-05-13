package tunbridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/qiufeihai/4px/apps/go/pkg/clientcore"
	_ "github.com/xjasonlyu/tun2socks/v2/dns"
	"github.com/xjasonlyu/tun2socks/v2/engine"
)

var (
	mu          sync.Mutex
	running     bool
	lastErr     string
	startedAt   int64
	lastCfg     Config
	proxyCancel context.CancelFunc
	proxyDone   chan error
)

type Config struct {
	// Proxy is optional. If empty, it uses socks5:// + SocksListen.
	Proxy string `json:"proxy"`
	// MTU is the tun MTU.
	MTU int `json:"mtu"`
	// LogLevel matches tun2socks levels: debug|info|warn|error|silent
	LogLevel string `json:"logLevel"`
	// Local socks endpoint exposed by embedded clientcore.
	SocksListen string `json:"socksListen"`
	// Upstream auth and endpoint for 4px server.
	UpstreamHost       string `json:"upstreamHost"`
	UpstreamPort       int    `json:"upstreamPort"`
	AuthToken          string `json:"authToken"`
	RejectUnauthorized bool   `json:"rejectUnauthorized"`
	ServerName         string `json:"serverName"`
	DeviceID           string `json:"deviceId"`
	DeviceTicket       string `json:"deviceTicket"`
	TunFD              int    `json:"tunFd"`
}

func normalizeConfig(in Config) Config {
	out := in
	if out.MTU <= 0 {
		out.MTU = 1500
	}
	if out.LogLevel == "" {
		out.LogLevel = "warn"
	}
	if out.SocksListen == "" {
		out.SocksListen = "127.0.0.1:1080"
	}
	if out.UpstreamPort <= 0 {
		out.UpstreamPort = 6666
	}
	if out.ServerName == "" {
		out.ServerName = out.UpstreamHost
	}
	if !strings.HasPrefix(out.Proxy, "socks5://") && out.Proxy != "" {
		out.Proxy = ""
	}
	return out
}

func setLastErrorLocked(err error) {
	if err == nil {
		lastErr = ""
		return
	}
	lastErr = err.Error()
}

func makeProxyURL(cfg Config) string {
	if cfg.Proxy != "" {
		return cfg.Proxy
	}
	return "socks5://" + cfg.SocksListen
}

func runEmbeddedProxyLocked(cfg Config) error {
	if cfg.UpstreamHost == "" {
		return errors.New("tunbridge: empty upstreamHost")
	}
	if cfg.AuthToken == "" {
		return errors.New("tunbridge: empty authToken")
	}
	runCfg := &clientcore.Config{
		SocksListen:        cfg.SocksListen,
		HTTPListen:         "",
		UpstreamHost:       cfg.UpstreamHost,
		UpstreamPort:       cfg.UpstreamPort,
		UpstreamPath:       "/proxy",
		ServerName:         cfg.ServerName,
		AuthToken:          cfg.AuthToken,
		RejectUnauthorized: cfg.RejectUnauthorized,
		CAFile:             "",
		DeviceID:           cfg.DeviceID,
		DeviceTicket:       cfg.DeviceTicket,
		LogLevel:           "WARN",
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- clientcore.RunProxyWithContext(ctx, runCfg)
	}()
	// Wait briefly until local socks listener is ready.
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", cfg.SocksListen, 150*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			proxyCancel = cancel
			proxyDone = done
			return nil
		}
		time.Sleep(120 * time.Millisecond)
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			return fmt.Errorf("embedded proxy start failed: %w", err)
		}
	default:
	}
	return fmt.Errorf("embedded proxy not ready on %s", cfg.SocksListen)
}

func stopEmbeddedProxyLocked() {
	if proxyCancel == nil {
		return
	}
	proxyCancel()
	if proxyDone != nil {
		select {
		case <-proxyDone:
		case <-time.After(2 * time.Second):
		}
	}
	proxyCancel = nil
	proxyDone = nil
}

// Start boots tun2socks with Android TUN fd and upstream SOCKS5 proxy URL.
// Example:
//
//	fd: 58
//	proxy: socks5://127.0.0.1:1080
func Start(fd int, proxy string) {
	mu.Lock()
	defer mu.Unlock()
	if err := startLocked(fd, proxy); err != nil {
		setLastErrorLocked(err)
		panic(err.Error())
	}
}

// Stop shuts tun2socks down.
func Stop() {
	mu.Lock()
	defer mu.Unlock()
	if !running {
		stopEmbeddedProxyLocked()
		return
	}
	engine.Stop()
	stopEmbeddedProxyLocked()
	running = false
}

func startLocked(fd int, proxy string) error {
	if running {
		return nil
	}
	if fd <= 0 {
		return errors.New("tunbridge: invalid fd")
	}
	cfg := normalizeConfig(lastCfg)
	if proxy != "" {
		cfg.Proxy = proxy
	}
	if err := runEmbeddedProxyLocked(cfg); err != nil {
		return err
	}
	proxyURL := makeProxyURL(cfg)
	key := &engine.Key{
		Device:   fmt.Sprintf("fd://%d", fd),
		Proxy:    proxyURL,
		MTU:      cfg.MTU,
		LogLevel: cfg.LogLevel,
	}
	engine.Insert(key)
	// engine.Start() calls log.Fatalf on failure, so we can only record errors we detect here.
	setLastErrorLocked(nil)
	engine.Start()
	running = true
	startedAt = time.Now().UnixMilli()
	cfg.Proxy = proxyURL
	lastCfg = cfg
	return nil
}

// IsRunning returns current runtime state.
func IsRunning() bool {
	mu.Lock()
	defer mu.Unlock()
	return running
}

// UpdateConfig applies non-critical config updates.
// NOTE: For now it only stores config for UI and future use; tun2socks default engine does not support hot reload safely.
func UpdateConfig(configJSON string) {
	mu.Lock()
	defer mu.Unlock()
	if configJSON == "" {
		return
	}
	var cfg Config
	if err := json.Unmarshal([]byte(configJSON), &cfg); err != nil {
		setLastErrorLocked(err)
		return
	}
	lastCfg = normalizeConfig(cfg)
}

type Stats struct {
	Running     bool   `json:"running"`
	StartedAtMs int64  `json:"startedAtMs"`
	LastError   string `json:"lastError"`
	Proxy       string `json:"proxy"`
	MTU         int    `json:"mtu"`
	LogLevel    string `json:"logLevel"`
}

type BridgeResult struct {
	OK               bool   `json:"ok"`
	Error            string `json:"error,omitempty"`
	NextDeviceTicket string `json:"nextDeviceTicket,omitempty"`
}

type SessionStatusBridgeResult struct {
	OK            bool   `json:"ok"`
	Error         string `json:"error,omitempty"`
	ExpireAt      string `json:"expireAt,omitempty"`
	RemainingDays int    `json:"remainingDays"`
	Expired       bool   `json:"expired"`
	ServerTime    string `json:"serverTime,omitempty"`
}

type StartBridgeResult struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

// GetStats returns a JSON string for easy consumption from Android/iOS.
func GetStats() string {
	mu.Lock()
	s := Stats{
		Running:     running,
		StartedAtMs: startedAt,
		LastError:   lastErr,
		Proxy:       lastCfg.Proxy,
		MTU:         lastCfg.MTU,
		LogLevel:    lastCfg.LogLevel,
	}
	mu.Unlock()
	b, _ := json.Marshal(s)
	return string(b)
}

func GetLastError() string {
	mu.Lock()
	defer mu.Unlock()
	return lastErr
}

func ConnectProbe(configJSON string) string {
	mu.Lock()
	if configJSON != "" {
		var cfg Config
		if err := json.Unmarshal([]byte(configJSON), &cfg); err != nil {
			setLastErrorLocked(err)
			out, _ := json.Marshal(BridgeResult{OK: false, Error: err.Error()})
			mu.Unlock()
			return string(out)
		}
		lastCfg = normalizeConfig(cfg)
	}
	cfg := lastCfg
	mu.Unlock()

	runCfg := &clientcore.Config{
		SocksListen:              cfg.SocksListen,
		HTTPListen:               "",
		UpstreamHost:             cfg.UpstreamHost,
		UpstreamPort:             cfg.UpstreamPort,
		UpstreamPath:             "/proxy",
		ServerName:               cfg.ServerName,
		AuthToken:                cfg.AuthToken,
		RejectUnauthorized:       cfg.RejectUnauthorized,
		CAFile:                   "",
		DeviceID:                 cfg.DeviceID,
		DeviceTicket:             cfg.DeviceTicket,
		UpstreamConnectTimeoutMS: 15000,
		ResponseHeaderTimeoutMS:  10000,
		IdleTimeoutMS:            300000,
		LogLevel:                 "WARN",
	}
	res := clientcore.ConnectProbe(runCfg, "www.google.com", 443)
	if res.NextDeviceTicket != "" {
		mu.Lock()
		lastCfg.DeviceTicket = res.NextDeviceTicket
		mu.Unlock()
	}
	mu.Lock()
	if res.OK {
		setLastErrorLocked(nil)
	} else {
		setLastErrorLocked(errors.New(res.Error))
	}
	mu.Unlock()
	out, _ := json.Marshal(BridgeResult{
		OK:               res.OK,
		Error:            res.Error,
		NextDeviceTicket: res.NextDeviceTicket,
	})
	return string(out)
}

func Offline(configJSON string) string {
	mu.Lock()
	if configJSON != "" {
		var cfg Config
		if err := json.Unmarshal([]byte(configJSON), &cfg); err != nil {
			setLastErrorLocked(err)
			out, _ := json.Marshal(BridgeResult{OK: false, Error: err.Error()})
			mu.Unlock()
			return string(out)
		}
		lastCfg = normalizeConfig(cfg)
	}
	cfg := lastCfg
	mu.Unlock()

	runCfg := &clientcore.Config{
		SocksListen:              cfg.SocksListen,
		HTTPListen:               "",
		UpstreamHost:             cfg.UpstreamHost,
		UpstreamPort:             cfg.UpstreamPort,
		UpstreamPath:             "/proxy",
		ServerName:               cfg.ServerName,
		AuthToken:                cfg.AuthToken,
		RejectUnauthorized:       cfg.RejectUnauthorized,
		CAFile:                   "",
		DeviceID:                 cfg.DeviceID,
		DeviceTicket:             cfg.DeviceTicket,
		UpstreamConnectTimeoutMS: 15000,
		ResponseHeaderTimeoutMS:  10000,
		IdleTimeoutMS:            300000,
		LogLevel:                 "WARN",
	}
	res := clientcore.SendOffline(runCfg)
	if res.NextDeviceTicket != "" {
		mu.Lock()
		lastCfg.DeviceTicket = res.NextDeviceTicket
		mu.Unlock()
	}
	mu.Lock()
	if res.OK {
		setLastErrorLocked(nil)
	} else {
		setLastErrorLocked(errors.New(res.Error))
	}
	mu.Unlock()
	out, _ := json.Marshal(BridgeResult{
		OK:               res.OK,
		Error:            res.Error,
		NextDeviceTicket: res.NextDeviceTicket,
	})
	return string(out)
}

func SessionStatus(configJSON string) string {
	mu.Lock()
	if configJSON != "" {
		var cfg Config
		if err := json.Unmarshal([]byte(configJSON), &cfg); err != nil {
			setLastErrorLocked(err)
			out, _ := json.Marshal(SessionStatusBridgeResult{OK: false, Error: err.Error()})
			mu.Unlock()
			return string(out)
		}
		lastCfg = normalizeConfig(cfg)
	}
	cfg := lastCfg
	mu.Unlock()

	runCfg := &clientcore.Config{
		SocksListen:              cfg.SocksListen,
		HTTPListen:               "",
		UpstreamHost:             cfg.UpstreamHost,
		UpstreamPort:             cfg.UpstreamPort,
		UpstreamPath:             "/proxy",
		ServerName:               cfg.ServerName,
		AuthToken:                cfg.AuthToken,
		RejectUnauthorized:       cfg.RejectUnauthorized,
		CAFile:                   "",
		DeviceID:                 cfg.DeviceID,
		DeviceTicket:             cfg.DeviceTicket,
		UpstreamConnectTimeoutMS: 15000,
		ResponseHeaderTimeoutMS:  10000,
		IdleTimeoutMS:            300000,
		LogLevel:                 "WARN",
	}
	res := clientcore.GetSessionStatus(runCfg)
	mu.Lock()
	if res.OK {
		setLastErrorLocked(nil)
	} else {
		setLastErrorLocked(errors.New(res.Error))
	}
	mu.Unlock()
	out, _ := json.Marshal(SessionStatusBridgeResult{
		OK:            res.OK,
		Error:         res.Error,
		ExpireAt:      res.ExpireAt,
		RemainingDays: res.RemainingDays,
		Expired:       res.Expired,
		ServerTime:    res.ServerTime,
	})
	return string(out)
}

func StartWithConfig(configJSON string) string {
	mu.Lock()
	if configJSON == "" {
		out, _ := json.Marshal(StartBridgeResult{OK: false, Error: "empty config"})
		mu.Unlock()
		return string(out)
	}
	var cfg Config
	if err := json.Unmarshal([]byte(configJSON), &cfg); err != nil {
		setLastErrorLocked(err)
		out, _ := json.Marshal(StartBridgeResult{OK: false, Error: err.Error()})
		mu.Unlock()
		return string(out)
	}
	cfg = normalizeConfig(cfg)
	lastCfg = cfg
	err := startLocked(cfg.TunFD, cfg.Proxy)
	if err != nil {
		setLastErrorLocked(err)
		out, _ := json.Marshal(StartBridgeResult{OK: false, Error: err.Error()})
		mu.Unlock()
		return string(out)
	}
	out, _ := json.Marshal(StartBridgeResult{OK: true})
	mu.Unlock()
	return string(out)
}

func init() {
	lastCfg = normalizeConfig(Config{
		RejectUnauthorized: true,
	})
}

func SetDeviceTicket(ticket string) {
	mu.Lock()
	defer mu.Unlock()
	lastCfg.DeviceTicket = strings.TrimSpace(ticket)
}

func SetUpstream(host string, port int, token string, rejectUnauthorized bool, serverName string) {
	mu.Lock()
	defer mu.Unlock()
	lastCfg.UpstreamHost = strings.TrimSpace(host)
	if port > 0 {
		lastCfg.UpstreamPort = port
	}
	lastCfg.AuthToken = strings.TrimSpace(token)
	lastCfg.RejectUnauthorized = rejectUnauthorized
	lastCfg.ServerName = strings.TrimSpace(serverName)
}

func SetSocksListen(host string, port int) {
	mu.Lock()
	defer mu.Unlock()
	h := strings.TrimSpace(host)
	if h == "" {
		h = "127.0.0.1"
	}
	p := port
	if p <= 0 {
		p = 1080
	}
	lastCfg.SocksListen = net.JoinHostPort(h, strconv.Itoa(p))
}
