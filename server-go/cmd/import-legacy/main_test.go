package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCLIReportBoundaries(t *testing.T) {
	root := t.TempDir()
	var stderr bytes.Buffer
	args := []string{"--snapshot", root, "--source-version", "test", "--output"}
	inside := filepath.Join(root, "report.json")
	if code := run(append(args, inside), &stderr); code != 2 {
		t.Fatal(code)
	}
	if _, err := os.Stat(inside); !os.IsNotExist(err) {
		t.Fatal("wrote inside snapshot")
	}
	outside := filepath.Join(t.TempDir(), "report.json")
	if code := run(append(args, outside), &stderr); code != 1 {
		t.Fatal("empty snapshot must yield findings", code)
	}
	original, _ := os.ReadFile(outside)
	if !strings.Contains(string(original), `"importReady": false`) {
		t.Fatal("missing readiness warning")
	}
	if code := run(append(args, outside), &stderr); code != 2 {
		t.Fatal("overwrote report", code)
	}
	after, _ := os.ReadFile(outside)
	if !bytes.Equal(original, after) {
		t.Fatal("changed existing report")
	}
	if code := run(nil, &stderr); code != 2 {
		t.Fatal("accepted missing flags")
	}
}
