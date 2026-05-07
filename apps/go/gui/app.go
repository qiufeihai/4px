package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/qiufeihai/4px/apps/go/pkg/clientcore"
)

const maxLogLines = 2000

type ClientStatus struct {
	Running             bool   `json:"running"`
	PID                 int    `json:"pid"`
	ConfigPath          string `json:"configPath"`
	LastStartedAt       string `json:"lastStartedAt"`
	LastExitedAt        string `json:"lastExitedAt"`
	LastError           string `json:"lastError"`
}

type App struct {
	ctx            context.Context
	mu             sync.Mutex
	clientCancel   context.CancelFunc
	packaged       bool
	repoRoot       string
	goClientDir    string
	runDir         string
	logLines       []string
	lastConfigPath string
	lastStartedAt  time.Time
	lastExitedAt   time.Time
	lastError      string
}

func NewApp() *App {
	cwd, _ := os.Getwd()
	execPath, _ := os.Executable()
	execDir := filepath.Dir(execPath)
	packaged := isPackagedApp(execPath)
	goClientDir := detectGoClientDir(cwd, execDir)
	runDir := resolveRunDir(cwd, execDir)
	repoRoot := filepath.Clean(filepath.Join(cwd, "..", "..", ".."))
	if goClientDir != "" {
		repoRoot = filepath.Clean(filepath.Join(goClientDir, ".."))
	}
	return &App{
		packaged:   packaged,
		repoRoot:    repoRoot,
		goClientDir: goClientDir,
		runDir:      runDir,
	}
}

func (a *App) Startup(ctx context.Context) {
	a.ctx = ctx
}

func (a *App) defaultClientConfigPath() string {
	// Packaged app: use current runtime directory by default.
	// Missing file will be auto-created there.
	if a.packaged && a.runDir != "" {
		return filepath.Join(a.runDir, "client.json")
	}
	// Dev run in repo: prefer apps/go/config/client.json.
	if a.goClientDir != "" {
		return filepath.Join(a.goClientDir, "config", "client.json")
	}
	// Fallback to runtime directory when outside repo.
	if a.runDir != "" {
		return filepath.Join(a.runDir, "client.json")
	}
	// Last fallback.
	return "client.json"
}

func (a *App) LoadConfig(path string) (map[string]any, error) {
	cfgPath := path
	if cfgPath == "" {
		cfgPath = a.defaultClientConfigPath()
	}
	if err := a.ensureConfigFile(cfgPath); err != nil {
		return nil, err
	}
	data, err := os.ReadFile(cfgPath)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (a *App) SaveConfig(path string, cfg map[string]any) error {
	cfgPath := path
	if cfgPath == "" {
		cfgPath = a.defaultClientConfigPath()
	}
	if err := os.MkdirAll(filepath.Dir(cfgPath), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(cfgPath, append(data, '\n'), 0o644)
}

func (a *App) StartClient(configPath string) error {
	a.mu.Lock()
	if a.clientCancel != nil {
		a.mu.Unlock()
		return errors.New("client is already running")
	}

	cfgPath := strings.TrimSpace(configPath)
	if cfgPath == "" {
		cfgPath = a.defaultClientConfigPath()
	}

	if err := a.ensureConfigFile(cfgPath); err != nil {
		a.mu.Unlock()
		return err
	}
	cfg, err := clientcore.LoadConfig(cfgPath)
	if err != nil {
		a.mu.Unlock()
		return err
	}

	runCtx, cancel := context.WithCancel(context.Background())
	a.clientCancel = cancel
	a.lastConfigPath = cfgPath
	a.lastStartedAt = time.Now()
	a.lastError = ""
	a.pushLogLineLocked(fmt.Sprintf("[%s] client started with config: %s", a.lastStartedAt.Format(time.RFC3339), cfgPath))
	clientcore.SetLogSink(func(line string) {
		a.mu.Lock()
		defer a.mu.Unlock()
		a.pushLogLineLocked(line)
	})
	a.mu.Unlock()

	go func() {
		waitErr := clientcore.RunProxyWithContext(runCtx, cfg)
		a.mu.Lock()
		defer a.mu.Unlock()
		clientcore.SetLogSink(nil)
		a.clientCancel = nil
		a.lastExitedAt = time.Now()
		if waitErr != nil {
			a.lastError = waitErr.Error()
			a.pushLogLineLocked(fmt.Sprintf("[%s] client exited with error: %v", a.lastExitedAt.Format(time.RFC3339), waitErr))
			return
		}
		a.pushLogLineLocked(fmt.Sprintf("[%s] client exited", a.lastExitedAt.Format(time.RFC3339)))
	}()
	return nil
}

func (a *App) StopClient(autoDisableSystemProxy bool) error {
	a.mu.Lock()
	if a.clientCancel == nil {
		a.mu.Unlock()
		return errors.New("client is not running")
	}
	cancel := a.clientCancel
	cfgPath := a.lastConfigPath
	if strings.TrimSpace(cfgPath) == "" {
		cfgPath = a.defaultClientConfigPath()
	}
	a.pushLogLineLocked(fmt.Sprintf("[%s] stopping client...", time.Now().Format(time.RFC3339)))
	a.mu.Unlock()

	cancel()

	if !autoDisableSystemProxy {
		return nil
	}

	cfg, err := a.loadClientCoreConfig(cfgPath)
	if err != nil {
		return fmt.Errorf("client stopped but load config failed: %w", err)
	}
	if err := clientcore.SetSystemProxy(cfg, false); err != nil {
		a.mu.Lock()
		a.pushLogLineLocked(fmt.Sprintf("[sysproxy-disable] auto clean failed: %v", err))
		a.mu.Unlock()
		return fmt.Errorf("client stopped but disable system proxy failed: %w", err)
	}
	a.mu.Lock()
	a.pushLogLineLocked(fmt.Sprintf("[%s] auto disabled system proxy", time.Now().Format(time.RFC3339)))
	a.mu.Unlock()
	return nil
}

func (a *App) IsClientRunning() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.clientCancel != nil
}

func (a *App) GetClientStatus() ClientStatus {
	a.mu.Lock()
	defer a.mu.Unlock()

	status := ClientStatus{
		Running:    a.clientCancel != nil,
		ConfigPath: a.lastConfigPath,
		LastError:  a.lastError,
	}
	status.PID = os.Getpid()
	if !a.lastStartedAt.IsZero() {
		status.LastStartedAt = a.lastStartedAt.Format(time.RFC3339)
	}
	if !a.lastExitedAt.IsZero() {
		status.LastExitedAt = a.lastExitedAt.Format(time.RFC3339)
	}
	return status
}

func (a *App) GetClientLogs(limit int) []string {
	a.mu.Lock()
	defer a.mu.Unlock()

	total := len(a.logLines)
	if total == 0 {
		return []string{}
	}
	if limit <= 0 || limit >= total {
		out := make([]string, total)
		copy(out, a.logLines)
		return out
	}
	start := total - limit
	out := make([]string, total-start)
	copy(out, a.logLines[start:])
	return out
}

func (a *App) ClearClientLogs() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.logLines = nil
}

func (a *App) SystemProxyEnable(configPath string) error {
	cfg, err := a.loadClientCoreConfig(configPath)
	if err != nil {
		return err
	}
	a.mu.Lock()
	a.pushLogLineLocked(fmt.Sprintf("[%s] run action: sysproxy-enable", time.Now().Format(time.RFC3339)))
	a.mu.Unlock()
	if err := clientcore.SetSystemProxy(cfg, true); err != nil {
		a.mu.Lock()
		a.pushLogLineLocked(fmt.Sprintf("[sysproxy-enable] action failed: %v", err))
		a.mu.Unlock()
		return err
	}
	return nil
}

func (a *App) SystemProxyDisable(configPath string) error {
	cfg, err := a.loadClientCoreConfig(configPath)
	if err != nil {
		return err
	}
	a.mu.Lock()
	a.pushLogLineLocked(fmt.Sprintf("[%s] run action: sysproxy-disable", time.Now().Format(time.RFC3339)))
	a.mu.Unlock()
	if err := clientcore.SetSystemProxy(cfg, false); err != nil {
		a.mu.Lock()
		a.pushLogLineLocked(fmt.Sprintf("[sysproxy-disable] action failed: %v", err))
		a.mu.Unlock()
		return err
	}
	return nil
}

func (a *App) SystemProxyStatus(configPath string) (string, error) {
	a.mu.Lock()
	a.pushLogLineLocked(fmt.Sprintf("[%s] run action: sysproxy-status", time.Now().Format(time.RFC3339)))
	a.mu.Unlock()
	out, err := clientcore.GetSystemProxyStatus()
	output := strings.TrimRight(out, "\n")
	if output != "" {
		for _, line := range strings.Split(output, "\n") {
			a.mu.Lock()
			a.pushLogLineLocked(fmt.Sprintf("[sysproxy-status] %s", line))
			a.mu.Unlock()
		}
	}
	if err != nil {
		a.mu.Lock()
		a.pushLogLineLocked(fmt.Sprintf("[sysproxy-status] action failed: %v", err))
		a.mu.Unlock()
		return out, err
	}
	return out, nil
}

func (a *App) pushLogLineLocked(line string) {
	a.logLines = append(a.logLines, line)
	if len(a.logLines) <= maxLogLines {
		return
	}
	a.logLines = append([]string(nil), a.logLines[len(a.logLines)-maxLogLines:]...)
}

func (a *App) ensureConfigFile(cfgPath string) error {
	if _, err := os.Stat(cfgPath); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}

	if err := os.MkdirAll(filepath.Dir(cfgPath), 0o755); err != nil {
		return err
	}
	template, err := a.readDefaultConfigTemplate()
	if err != nil {
		return err
	}
	return os.WriteFile(cfgPath, append(template, '\n'), 0o644)
}

func (a *App) readDefaultConfigTemplate() ([]byte, error) {
	if a.goClientDir != "" {
		examplePath := filepath.Join(a.goClientDir, "config", "client.example.json")
		data, err := os.ReadFile(examplePath)
		if err == nil {
			return bytesTrimRightLF(data), nil
		}
		if !os.IsNotExist(err) {
			return nil, err
		}
	}

	cfg := map[string]any{
		"socks_listen":                "127.0.0.1:7777",
		"http_listen":                 "127.0.0.1:7788",
		"upstream_host":               "your-server-ip",
		"upstream_port":               6666,
		"upstream_path":               "/proxy",
		"server_name":                 "your-domain.com",
		"auth_token":                  "change-me-strong-token",
		"reject_unauthorized":         true,
		"ca_file":                     "",
		"upstream_connect_timeout_ms": 15000,
		"response_header_timeout_ms":  30000,
		"idle_timeout_ms":             300000,
		"upstream_max_idle_conns":     512,
		"upstream_max_idle_conns_per_host": 512,
		"upstream_max_conns_per_host":      0,
		"upstream_disable_compression":     true,
		"upstream_h2_read_idle_timeout_ms": 30000,
		"upstream_h2_ping_timeout_ms":      10000,
		"client_instance_id":               "",
		"log_level":                   "INFO",
	}
	raw, marshalErr := json.MarshalIndent(cfg, "", "  ")
	if marshalErr != nil {
		return nil, marshalErr
	}
	return raw, nil
}

func detectGoClientDir(candidates ...string) string {
	for _, start := range candidates {
		cur := strings.TrimSpace(start)
		if cur == "" {
			continue
		}
		for i := 0; i < 8; i++ {
			example := filepath.Join(cur, "config", "client.example.json")
			if st, err := os.Stat(example); err == nil && !st.IsDir() {
				return cur
			}
			parent := filepath.Dir(cur)
			if parent == cur {
				break
			}
			cur = parent
		}
	}
	return ""
}

func resolveRunDir(cwd, execDir string) string {
	wd := strings.TrimSpace(cwd)
	if wd != "" && wd != "/" {
		return wd
	}
	ed := strings.TrimSpace(execDir)
	if ed != "" {
		return ed
	}
	return "."
}

func isPackagedApp(execPath string) bool {
	p := strings.ToLower(filepath.ToSlash(strings.TrimSpace(execPath)))
	return strings.Contains(p, ".app/contents/macos/")
}

func bytesTrimRightLF(b []byte) []byte {
	s := strings.TrimRight(string(b), "\r\n")
	return []byte(s)
}

func (a *App) loadClientCoreConfig(configPath string) (*clientcore.Config, error) {
	cfgPath := strings.TrimSpace(configPath)
	if cfgPath == "" {
		cfgPath = a.defaultClientConfigPath()
	}
	if err := a.ensureConfigFile(cfgPath); err != nil {
		return nil, err
	}
	return clientcore.LoadConfig(cfgPath)
}
