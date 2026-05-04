package main

import (
	"os"

	"github.com/qiufeihai/4px/apps/go/pkg/clientcore"
)

func main() {
	os.Exit(clientcore.RunCLI(os.Args[1:]))
}
