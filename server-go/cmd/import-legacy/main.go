// import-legacy currently exposes only the M0 read-only inventory stage.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"fishing.local/server/internal/legacy"
)

func run(args []string, stderr io.Writer) int {
	flags := flag.NewFlagSet("import-legacy", flag.ContinueOnError)
	flags.SetOutput(stderr)
	snapshot := flags.String("snapshot", "", "immutable offline snapshot directory (required)")
	version := flags.String("source-version", "", "operator-verified legacy version (required)")
	output := flags.String("output", "", "new report file outside snapshot (required)")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if flags.NArg() != 0 || *snapshot == "" || *output == "" || strings.TrimSpace(*version) == "" {
		fmt.Fprintln(stderr, "Required: --snapshot DIR --source-version VERSION --output NEW_FILE")
		return 2
	}
	root, err := filepath.EvalSymlinks(*snapshot)
	if err != nil {
		fmt.Fprintln(stderr, "Snapshot is unavailable")
		return 2
	}
	root, err = filepath.Abs(root)
	if err != nil {
		return 2
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(*output))
	if err != nil {
		fmt.Fprintln(stderr, "Report parent directory must exist")
		return 2
	}
	parent, err = filepath.Abs(parent)
	if err != nil {
		return 2
	}
	dest := filepath.Join(parent, filepath.Base(*output))
	rel, err := filepath.Rel(root, dest)
	if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel) {
		fmt.Fprintln(stderr, "Report must be outside snapshot")
		return 2
	}
	report, err := legacy.Scan(root, *version)
	if err != nil {
		fmt.Fprintln(stderr, "Snapshot scan failed; no report written")
		return 2
	}
	data, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return 2
	}
	f, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		fmt.Fprintln(stderr, "Cannot create report; existing files are never overwritten")
		return 2
	}
	_, writeErr := f.Write(append(data, '\n'))
	syncErr := f.Sync()
	closeErr := f.Close()
	if writeErr != nil || syncErr != nil || closeErr != nil {
		fmt.Fprintln(stderr, "Report write failed; discard partial report")
		return 2
	}
	fmt.Fprintf(stderr, "Scanned %d files; %d findings. Import readiness remains unverified.\n", len(report.Files), len(report.Issues))
	if len(report.Issues) > 0 {
		return 1
	}
	return 0
}

func main() { os.Exit(run(os.Args[1:], os.Stderr)) }
