package assets

import (
	"embed"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
)

//go:embed web/*
var embeddedFS embed.FS

// Handler creates an HTTP handler that serves embedded static files
func Handler() http.Handler {
	// Try to get the web subdirectory
	webFS, err := fs.Sub(embeddedFS, "web")
	if err != nil {
		// Return empty handler if no embedded files
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.NotFound(w, r)
		})
	}

	return &staticHandler{fs: webFS}
}

type staticHandler struct {
	fs fs.FS
}

func (h *staticHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	urlPath := r.URL.Path
	if urlPath == "/" {
		urlPath = "/index.html"
	}

	// Clean the path
	urlPath = path.Clean(urlPath)
	urlPath = strings.TrimPrefix(urlPath, "/")

	// Try to open the file
	file, err := h.fs.Open(urlPath)
	if err != nil {
		// For SPA routing, serve index.html for unknown paths
		if !strings.Contains(urlPath, ".") {
			if indexFile, err := h.fs.Open("index.html"); err == nil {
				defer indexFile.Close()
				rs, ok := indexFile.(readSeeker)
				if !ok {
					http.Error(w, "Internal Server Error", http.StatusInternalServerError)
					return
				}
				stat, err := indexFile.Stat()
				if err != nil {
					http.Error(w, "Internal Server Error", http.StatusInternalServerError)
					return
				}
				w.Header().Set("Content-Type", "text/html; charset=utf-8")
				http.ServeContent(w, r, "index.html", stat.ModTime(), rs)
				return
			}
		}
		http.NotFound(w, r)
		return
	}
	defer file.Close()

	stat, err := file.Stat()
	if err != nil {
		http.NotFound(w, r)
		return
	}

	if stat.IsDir() {
		// Try index.html in directory
		indexPath := path.Join(urlPath, "index.html")
		if indexFile, err := h.fs.Open(indexPath); err == nil {
			defer indexFile.Close()
			rs, ok := indexFile.(readSeeker)
			if !ok {
				http.Error(w, "Internal Server Error", http.StatusInternalServerError)
				return
			}
			stat, err := indexFile.Stat()
			if err != nil {
				http.Error(w, "Internal Server Error", http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			http.ServeContent(w, r, "index.html", stat.ModTime(), rs)
			return
		}
		http.NotFound(w, r)
		return
	}

	// Set content type based on extension
	ext := path.Ext(urlPath)
	contentType := mime.TypeByExtension(ext)
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType)

	// Set cache headers for assets
	if strings.HasPrefix(urlPath, "assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}

	rs, ok := file.(readSeeker)
	if !ok {
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}
	http.ServeContent(w, r, stat.Name(), stat.ModTime(), rs)
}

type readSeeker interface {
	Read(p []byte) (n int, err error)
	Seek(offset int64, whence int) (int64, error)
}

// HasEmbeddedAssets returns true if there are embedded assets available
func HasEmbeddedAssets() bool {
	entries, err := embeddedFS.ReadDir("web")
	return err == nil && len(entries) > 0
}
