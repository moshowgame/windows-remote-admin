package handler

import (
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gin-contrib/sessions"
	"github.com/gin-gonic/gin"

	"windows-remote-admin-go/internal/model"
	"windows-remote-admin-go/internal/service"
	"windows-remote-admin-go/internal/util"
)

// FileHandler 文件管理处理器
type FileHandler struct {
	fsService *service.FileSystemService
}

// NewFileHandler 创建 FileHandler
func NewFileHandler() *FileHandler {
	return &FileHandler{
		fsService: service.GetFileSystemService(),
	}
}

// FilePage 文件资源管理器页面
func (h *FileHandler) FilePage(c *gin.Context) {
	c.HTML(http.StatusOK, "explorer.html", nil)
}

// TextViewerPage 文本编辑器页面
func (h *FileHandler) TextViewerPage(c *gin.Context) {
	fp := c.Query("filePath")
	c.HTML(http.StatusOK, "texteditor.html", gin.H{
		"filePath": fp,
	})
}

// LogViewerPage 日志监控器页面
func (h *FileHandler) LogViewerPage(c *gin.Context) {
	fp := c.Query("filePath")
	fnp := c.Query("fileNamePattern")
	kw := c.Query("keyWord")
	c.HTML(http.StatusOK, "logmonitor.html", gin.H{
		"filePath":        fp,
		"fileNamePattern": fnp,
		"keyWord":         kw,
	})
}

// ListFiles 列出文件
func (h *FileHandler) ListFiles(c *gin.Context) {
	var req model.FileRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		util.Fail(c, util.StatusBadRequest, "请求参数格式错误")
		return
	}

	session := sessions.Default(c)
	user, _ := session.Get("entitledUser").(string)
	purpose, _ := session.Get("purpose").(string)

	log.Printf("Audit Log - List files | User: %s | Purpose: %s | Path: %s",
		user, purpose, req.FilePath)

	normalizedPath, _ := h.fsService.NormalizePath(req.FilePath)
	files, err := h.fsService.ListFiles(normalizedPath)
	if err != nil {
		log.Printf("Error listing files: %v", err)
		util.Fail(c, util.StatusInternalErr, fmt.Sprintf("Access Denied or IO Error: %v", err))
		return
	}

	util.Success(c, files)
}

// DownloadFile 下载文件
func (h *FileHandler) DownloadFile(c *gin.Context) {
	var req model.FileRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		util.Fail(c, util.StatusBadRequest, "请求参数格式错误")
		return
	}

	session := sessions.Default(c)
	user, _ := session.Get("entitledUser").(string)
	purpose, _ := session.Get("purpose").(string)

	filePath := strings.ReplaceAll(req.FilePath, "//", "")
	normalizedPath, _ := h.fsService.NormalizePath(filePath)

	log.Printf("Audit Log - Download | User: %s | Purpose: %s | Path: %s",
		user, purpose, normalizedPath)

	// 检查文件是否存在
	if _, err := os.Stat(normalizedPath); os.IsNotExist(err) {
		util.Fail(c, util.StatusNotFound, "文件不存在")
		return
	}

	fileName := filepath.Base(normalizedPath)
	downloadName := fmt.Sprintf("%d_%s", time.Now().UnixMilli(), fileName)

	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s\"", downloadName))
	c.Header("Content-Type", "application/octet-stream")
	c.File(normalizedPath)
}

// ListFilesPlus 带搜索条件的文件列表
func (h *FileHandler) ListFilesPlus(c *gin.Context) {
	var req model.FileRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		util.Fail(c, util.StatusBadRequest, "请求参数格式错误")
		return
	}

	session := sessions.Default(c)
	user, _ := session.Get("entitledUser").(string)
	purpose, _ := session.Get("purpose").(string)

	log.Printf("Audit Log - ListFilesPlus | User: %s | Purpose: %s | Path: %s | Pattern: %s | Keyword: %s | Days: %s",
		user, purpose, req.FilePath, req.FileNamePattern, req.KeyWord, req.Days)

	normalizedPath, _ := h.fsService.NormalizePath(req.FilePath)

	days := 0
	if req.Days != "" {
		d, err := strconv.Atoi(req.Days)
		if err == nil {
			days = d
		}
	}

	files, err := h.fsService.ListFilesPlus(normalizedPath, req.FileNamePattern, req.KeyWord, days)
	if err != nil {
		log.Printf("Error listing files plus: %v", err)
		util.Fail(c, util.StatusInternalErr, fmt.Sprintf("Access Denied or IO Error: %v", err))
		return
	}

	util.Success(c, files)
}

// NormalizePath 规范化路径
func (h *FileHandler) NormalizePath(c *gin.Context) {
	var req model.FileRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		util.Fail(c, util.StatusBadRequest, "请求参数格式错误")
		return
	}

	normalized, err := h.fsService.NormalizePath(req.FilePath)
	if err != nil {
		log.Printf("Error normalizing path: %s -> %v", req.FilePath, err)
		util.Fail(c, util.StatusInternalErr, fmt.Sprintf("路径规范化失败: %v", err))
		return
	}

	log.Printf("Audit Log - Normalize path: %s -> %s", req.FilePath, normalized)
	util.Success(c, normalized)
}

// ReadFile 读取文本文件内容
func (h *FileHandler) ReadFile(c *gin.Context) {
	var req model.FileRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		util.Fail(c, util.StatusBadRequest, "请求参数格式错误")
		return
	}

	normalizedPath, _ := h.fsService.NormalizePath(req.FilePath)

	session := sessions.Default(c)
	user, _ := session.Get("entitledUser").(string)
	purpose, _ := session.Get("purpose").(string)

	log.Printf("Audit Log - Read File | User: %s | Purpose: %s | Path: %s",
		user, purpose, normalizedPath)

	// 检查文件是否存在
	fileInfo, err := os.Stat(normalizedPath)
	if err != nil {
		util.Fail(c, util.StatusNotFound, "文件不存在")
		return
	}

	if fileInfo.IsDir() {
		util.Fail(c, util.StatusBadRequest, "无法读取目录，请选择具体文件")
		return
	}

	if fileInfo.Size() > 10*1024*1024 {
		util.Fail(c, util.StatusInternalErr, "File exceeds 10MB limit")
		return
	}

	// 检查文件类型（内容类型检测）
	file, err := os.Open(normalizedPath)
	if err != nil {
		util.Fail(c, util.StatusInternalErr, fmt.Sprintf("无法打开文件: %v", err))
		return
	}
	defer file.Close()

	// 读取前 512 字节检测内容类型，然后重置
	buf := make([]byte, 512)
	n, _ := file.Read(buf)
	contentType := http.DetectContentType(buf[:n])
	file.Seek(0, io.SeekStart)

	// 如果不是文本文件，检查是否是常见的文本类型
	lowerPath := strings.ToLower(normalizedPath)
	isTextLike := strings.HasSuffix(lowerPath, ".txt") ||
		strings.HasSuffix(lowerPath, ".log") ||
		strings.HasSuffix(lowerPath, ".json") ||
		strings.HasSuffix(lowerPath, ".xml")

	if !isTextLike && !strings.HasPrefix(contentType, "text/") {
		util.Fail(c, util.StatusInternalErr, fmt.Sprintf("File is not a text file: %s", contentType))
		return
	}

	// 读取文件内容
	content, err := os.ReadFile(normalizedPath)
	if err != nil {
		util.Fail(c, util.StatusInternalErr, fmt.Sprintf("读取文件失败: %v", err))
		return
	}

	// 尝试 UTF-8 解码，如果失败则返回原始内容
	c.String(http.StatusOK, string(content))
}

// UploadFile 上传文件到指定目录
func (h *FileHandler) UploadFile(c *gin.Context) {
	targetPath := c.PostForm("targetPath")

	session := sessions.Default(c)
	user, _ := session.Get("entitledUser").(string)
	purpose, _ := session.Get("purpose").(string)

	log.Printf("Audit Log - Upload File | User: %s | Purpose: %s | Target: %s",
		user, purpose, targetPath)

	// 规范化目标目录路径
	normalizedDir, _ := h.fsService.NormalizePath(targetPath)

	// 检查目标目录是否存在且为目录
	dirInfo, err := os.Stat(normalizedDir)
	if err != nil {
		if os.IsNotExist(err) {
			util.Fail(c, util.StatusNotFound, "目标目录不存在")
			return
		}
		util.Fail(c, util.StatusInternalErr, fmt.Sprintf("无法访问目标目录: %v", err))
		return
	}
	if !dirInfo.IsDir() {
		util.Fail(c, util.StatusBadRequest, "目标路径不是一个目录")
		return
	}

	// 获取上传的文件
	file, header, err := c.Request.FormFile("file")
	if err != nil {
		util.Fail(c, util.StatusBadRequest, fmt.Sprintf("获取上传文件失败: %v", err))
		return
	}
	defer file.Close()

	// 检查文件大小 (限制 100MB)
	if header.Size > 100*1024*1024 {
		util.Fail(c, util.StatusBadRequest, "文件大小超过 100MB 限制")
		return
	}

	// 构造目标文件路径
	destPath := filepath.Join(normalizedDir, header.Filename)

	// 检测目标文件是否已存在
	replaced := false
	if _, err := os.Stat(destPath); err == nil {
		replaced = true
		log.Printf("File exists, will be replaced: %s", destPath)
	}

	// 创建目标文件 (os.Create 会自动覆盖已存在的文件)
	dst, err := os.Create(destPath)
	if err != nil {
		util.Fail(c, util.StatusInternalErr, fmt.Sprintf("创建文件失败: %v", err))
		return
	}
	defer dst.Close()

	// 复制文件内容
	written, err := io.Copy(dst, file)
	if err != nil {
		os.Remove(destPath) // 清理不完整文件
		util.Fail(c, util.StatusInternalErr, fmt.Sprintf("写入文件失败: %v", err))
		return
	}

	log.Printf("Upload success: %s (%d bytes) replaced=%v", destPath, written, replaced)
	util.Success(c, map[string]interface{}{
		"fileName": header.Filename,
		"size":     written,
		"path":     destPath,
		"replaced": replaced,
	})
}

// formatFileSize 格式化文件大小
func formatFileSize(sizeStr string) string {
	size, err := strconv.ParseInt(sizeStr, 10, 64)
	if err != nil {
		return sizeStr
	}

	switch {
	case size >= 1024*1024*1024:
		return fmt.Sprintf("%.2f GB", float64(size)/(1024*1024*1024))
	case size >= 1024*1024:
		return fmt.Sprintf("%.2f MB", float64(size)/(1024*1024))
	case size >= 1024:
		return fmt.Sprintf("%.2f KB", float64(size)/(1024))
	default:
		return fmt.Sprintf("%d B", size)
	}
}
