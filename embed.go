package main

import (
	"embed"
	"io/fs"
	"net/http"
)

//go:embed web/static/*
var staticFS embed.FS

//go:embed web/templates/*
var templateFS embed.FS

//go:embed data/*
var dataFS embed.FS

// getStaticFS 获取嵌入的静态文件系统
func getStaticFS() http.FileSystem {
	sub, err := fs.Sub(staticFS, "web/static")
	if err != nil {
		panic(err)
	}
	return http.FS(sub)
}

// getDataFS 获取嵌入的数据文件系统
func getDataFS() fs.FS {
	sub, err := fs.Sub(dataFS, "data")
	if err != nil {
		panic(err)
	}
	return sub
}
