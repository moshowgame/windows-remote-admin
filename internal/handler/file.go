package handler

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gin-contrib/sessions"
	"github.com/gin-gonic/gin"

	"windows-remote-admin-go/internal/logger"
	"windows-remote-admin-go/internal/model"
	"windows-remote-admin-go/internal/service"
	"windows-remote-admin-go/internal/util"
)

type FileHandler struct {
	fsService *service.FileSystemService
}

func NewFileHandler() *FileHandler {
	return &FileHandler{
		fsService: service.GetFileSystemService(),
	}
}

func (h *FileHandler) FilePage(c *gin.Context) {
	c.HTML(http.StatusOK, "explorer.html", nil)
}

func (h *FileHandler) TextViewerPage(c *gin.Context) {
	fp := c.Query("filePath")
	c.HTML(http.StatusOK, "texteditor.html", gin.H{
		"filePath": fp,
	})
}

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

func (h *FileHandler) ListFiles(c *gin.Context) {
	var req model.FileRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		util.Fail(c, util.StatusBadRequest, "请求参数格式错误")
		return
	}

	session := sessions.Default(c)
	user, _ := session.Get("entitledUser").(string)
	purpose, _ := session.Get("purpose").(string)

	logger.Audit("列出目录文件",
		"username", user,
		"purpose", purpose,
		"path", req.FilePath,
	)

	normalizedPath, _ := h.fsService.NormalizePath(req.FilePath)
	files, err := h.fsService.ListFiles(normalizedPath)
	if err != nil {
		logger.Errorf("列出文件失败: %v, path=%s", err, req.FilePath)
		util.Fail(c, util.StatusInternalErr, fmt.Sprintf("Access Denied or IO Error: %v", err))
		return
	}

	util.Success(c, files)
}

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

	logger.Audit("下载文件",
		"username", user,
		"purpose", purpose,
		"path", normalizedPath,
	)

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

func (h *FileHandler) ListFilesPlus(c *gin.Context) {
	var req model.FileRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		util.Fail(c, util.StatusBadRequest, "请求参数格式错误")
		return
	}

	session := sessions.Default(c)
	user, _ := session.Get("entitledUser").(string)
	purpose, _ := session.Get("purpose").(string)

	logger.Audit("搜索文件",
		"username", user,
		"purpose", purpose,
		"path", req.FilePath,
		"pattern", req.FileNamePattern,
		"keyword", req.KeyWord,
		"days", req.Days,
	)

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
		logger.Errorf("搜索文件失败: %v, path=%s", err, req.FilePath)
		util.Fail(c, util.StatusInternalErr, fmt.Sprintf("Access Denied or IO Error: %v", err))
		return
	}

	util.Success(c, files)
}

func (h *FileHandler) NormalizePath(c *gin.Context) {
	var req model.FileRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		util.Fail(c, util.StatusBadRequest, "请求参数格式错误")
		return
	}

	normalized, err := h.fsService.NormalizePath(req.FilePath)
	if err != nil {
		logger.Errorf("路径规范化失败: %s -> %v", req.FilePath, err)
		util.Fail(c, util.StatusInternalErr, fmt.Sprintf("路径规范化失败: %v", err))
		return
	}

	logger.Audit("路径规范化",
		"original", req.FilePath,
		"normalized", normalized,
	)
	util.Success(c, normalized)
}

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

	logger.Audit("读取文本文件",
		"username", user,
		"purpose", purpose,
		"path", normalizedPath,
	)

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

	file, err := os.Open(normalizedPath)
	if err != nil {
		util.Fail(c, util.StatusInternalErr, fmt.Sprintf("无法打开文件: %v", err))
		return
	}
	defer file.Close()

	buf := make([]byte, 512)
	n, _ := file.Read(buf)
	contentType := http.DetectContentType(buf[:n])
	file.Seek(0, io.SeekStart)

	lowerPath := strings.ToLower(normalizedPath)
	isTextLike := strings.HasSuffix(lowerPath, ".txt") ||
		strings.HasSuffix(lowerPath, ".log") ||
		strings.HasSuffix(lowerPath, ".json") ||
		strings.HasSuffix(lowerPath, ".xml")

	if !isTextLike && !strings.HasPrefix(contentType, "text/") {
		util.Fail(c, util.StatusInternalErr, fmt.Sprintf("File is not a text file: %s", contentType))
		return
	}

	content, err := os.ReadFile(normalizedPath)
	if err != nil {
		util.Fail(c, util.StatusInternalErr, fmt.Sprintf("读取文件失败: %v", err))
		return
	}

	c.String(http.StatusOK, string(content))
}

func (h *FileHandler) UploadFile(c *gin.Context) {
	targetPath := c.PostForm("targetPath")

	session := sessions.Default(c)
	user, _ := session.Get("entitledUser").(string)
	purpose, _ := session.Get("purpose").(string)

	logger.Audit("上传文件",
		"username", user,
		"purpose", purpose,
		"targetPath", targetPath,
	)

	normalizedDir, _ := h.fsService.NormalizePath(targetPath)

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

	file, header, err := c.Request.FormFile("file")
	if err != nil {
		util.Fail(c, util.StatusBadRequest, fmt.Sprintf("获取上传文件失败: %v", err))
		return
	}
	defer file.Close()

	if header.Size > 100*1024*1024 {
		util.Fail(c, util.StatusBadRequest, "文件大小超过 100MB 限制")
		return
	}

	destPath := filepath.Join(normalizedDir, header.Filename)

	replaced := false
	if _, err := os.Stat(destPath); err == nil {
		replaced = true
	}

	dst, err := os.Create(destPath)
	if err != nil {
		util.Fail(c, util.StatusInternalErr, fmt.Sprintf("创建文件失败: %v", err))
		return
	}
	defer dst.Close()

	written, err := io.Copy(dst, file)
	if err != nil {
		os.Remove(destPath)
		util.Fail(c, util.StatusInternalErr, fmt.Sprintf("写入文件失败: %v", err))
		return
	}

	logger.Audit("文件上传成功",
		"destPath", destPath,
		"sizeBytes", written,
		"replaced", replaced,
		"username", user,
	)
	util.Success(c, map[string]interface{}{
		"fileName": header.Filename,
		"size":     written,
		"path":     destPath,
		"replaced": replaced,
	})
}

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
