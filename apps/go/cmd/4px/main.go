package main

import (
	"os"

	"docker-socks5-go-client/pkg/clientcore"
)

func main() {
	os.Exit(clientcore.RunCLI(os.Args[1:]))
}
