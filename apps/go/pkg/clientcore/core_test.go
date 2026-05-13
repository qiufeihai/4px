package clientcore

import (
	"bytes"
	"net"
	"os"
	"path/filepath"
	"testing"
)

func TestSOCKS5HandshakeSupportsUDPAssociate(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()

	done := make(chan socks5Request, 1)
	errCh := make(chan error, 1)
	go func() {
		req, err := socks5Handshake(server)
		if err != nil {
			errCh <- err
			return
		}
		done <- req
	}()

	_, _ = client.Write([]byte{0x05, 0x01, 0x00})
	reply := make([]byte, 2)
	if _, err := client.Read(reply); err != nil {
		t.Fatalf("read method reply: %v", err)
	}
	if !bytes.Equal(reply, []byte{0x05, 0x00}) {
		t.Fatalf("unexpected method reply: %v", reply)
	}

	_, _ = client.Write([]byte{0x05, 0x03, 0x00, 0x01, 1, 1, 1, 1, 0, 53})

	select {
	case err := <-errCh:
		t.Fatalf("handshake failed: %v", err)
	case req := <-done:
		if req.command != 0x03 {
			t.Fatalf("unexpected command: %d", req.command)
		}
		if req.host != "1.1.1.1" {
			t.Fatalf("unexpected host: %s", req.host)
		}
		if req.port != 53 {
			t.Fatalf("unexpected port: %d", req.port)
		}
	}
}

func TestSOCKS5UDPDatagramRoundTrip(t *testing.T) {
	payload := []byte{0xde, 0xad, 0xbe, 0xef}
	packet, err := buildSOCKS5UDPDatagram("8.8.8.8", 53, payload)
	if err != nil {
		t.Fatalf("build packet: %v", err)
	}

	host, port, gotPayload, err := parseSOCKS5UDPDatagram(packet)
	if err != nil {
		t.Fatalf("parse packet: %v", err)
	}
	if host != "8.8.8.8" {
		t.Fatalf("unexpected host: %s", host)
	}
	if port != 53 {
		t.Fatalf("unexpected port: %d", port)
	}
	if !bytes.Equal(gotPayload, payload) {
		t.Fatalf("unexpected payload: %x", gotPayload)
	}
}

func TestLoadConfigPersistsStableDeviceID(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "client.json")
	if err := os.WriteFile(configPath, []byte(`{"auth_token":"t","upstream_host":"h"}`), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg1, err := loadConfig(configPath)
	if err != nil {
		t.Fatalf("load first config: %v", err)
	}
	if cfg1.DeviceID == "" {
		t.Fatal("expected device id to be generated")
	}

	sidecarPath := deviceIDSidecarPath(configPath)
	if _, err := os.Stat(sidecarPath); err != nil {
		t.Fatalf("expected sidecar file: %v", err)
	}

	cfg2, err := loadConfig(configPath)
	if err != nil {
		t.Fatalf("load second config: %v", err)
	}
	if cfg1.DeviceID != cfg2.DeviceID {
		t.Fatalf("expected stable device id, got %q and %q", cfg1.DeviceID, cfg2.DeviceID)
	}
}
