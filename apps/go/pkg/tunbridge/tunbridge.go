package tunbridge

import (
	"encoding/json"
	"fmt"
	"sync"
	"time"

	_ "github.com/xjasonlyu/tun2socks/v2/dns"
	"github.com/xjasonlyu/tun2socks/v2/engine"
)

var (
	mu        sync.Mutex
	running   bool
	lastErr   string
	startedAt int64
	lastCfg   Config
)

type Config struct {
	// Proxy is a full proxy URL, e.g. socks5://127.0.0.1:1080
	Proxy string `json:"proxy"`
	// MTU is the tun MTU.
	MTU int `json:"mtu"`
	// LogLevel matches tun2socks levels: debug|info|warn|error|silent
	LogLevel string `json:"logLevel"`
}

func normalizeConfig(in Config) Config {
	out := in
	if out.MTU <= 0 {
		out.MTU = 1500
	}
	if out.LogLevel == "" {
		out.LogLevel = "warn"
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

// Start boots tun2socks with Android TUN fd and upstream SOCKS5 proxy URL.
// Example:
//
//	fd: 58
//	proxy: socks5://127.0.0.1:1080
func Start(fd int, proxy string) {
	mu.Lock()
	defer mu.Unlock()
	if running {
		return
	}
	if fd <= 0 {
		panic("tunbridge: invalid fd")
	}
	if proxy == "" {
		panic("tunbridge: empty proxy")
	}
	cfg := normalizeConfig(Config{Proxy: proxy})
	key := &engine.Key{
		Device:   fmt.Sprintf("fd://%d", fd),
		Proxy:    cfg.Proxy,
		MTU:      cfg.MTU,
		LogLevel: cfg.LogLevel,
	}
	engine.Insert(key)
	// engine.Start() calls log.Fatalf on failure, so we can only record errors we detect here.
	setLastErrorLocked(nil)
	engine.Start()
	running = true
	startedAt = time.Now().UnixMilli()
	lastCfg = cfg
}

// Stop shuts tun2socks down.
func Stop() {
	mu.Lock()
	defer mu.Unlock()
	if !running {
		return
	}
	engine.Stop()
	running = false
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
