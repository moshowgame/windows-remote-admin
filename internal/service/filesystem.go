package service

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"windows-remote-admin-go/internal/model"
)

// FileSystemService 文件系统服务
type FileSystemService struct{}

var fsService *FileSystemService

// GetFileSystemService 获取 FileSystemService 单例
func GetFileSystemService() *FileSystemService {
	if fsService == nil {
		fsService = &FileSystemService{}
	}
	return fsService
}

// ListFiles 列出指定路径下的所有文件
func (s *FileSystemService) ListFiles(path string) ([]model.FileInfo, error) {
	// 规范化路径
	absPath, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("invalid path: %v", err)
	}

	entries, err := os.ReadDir(absPath)
	if err != nil {
		return nil, fmt.Errorf("access denied or IO error: %v", err)
	}

	var files []model.FileInfo
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil {
			continue
		}

		fullPath := filepath.Join(absPath, entry.Name())

		fileInfo := model.FileInfo{
			Name:         entry.Name(),
			Path:         fullPath,
			IsDirectory:  entry.IsDir(),
			LastModified: formatTime(info.ModTime()),
		}

		if entry.IsDir() {
			fileInfo.Size = "0"
		} else {
			fileInfo.Size = fmt.Sprintf("%d", info.Size())
		}

		files = append(files, fileInfo)
	}

	// 按最后修改时间降序排序（与 Java 版本一致）
	sort.Slice(files, func(i, j int) bool {
		return files[i].LastModified > files[j].LastModified
	})

	return files, nil
}

// NormalizePath 规范化路径
func (s *FileSystemService) NormalizePath(path string) (string, error) {
	absPath, err := filepath.Abs(path)
	if err != nil {
		return path, nil // 如果无法获取绝对路径，返回原路径
	}
	// 确保路径末尾有反斜杠（如果是根目录）
	normalized := filepath.Clean(absPath)
	if strings.HasSuffix(normalized, ":") {
		normalized += "\\"
	}
	return normalized, nil
}

// formatTime 格式化时间
func formatTime(t time.Time) string {
	return t.Format("2006-01-02 15:04:05")
}

// ListFilesPlus 带搜索条件的文件列表
func (s *FileSystemService) ListFilesPlus(path, pattern, keyWord string, days int) ([]model.FileInfo, error) {
	absPath, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("invalid path: %v", err)
	}

	entries, err := os.ReadDir(absPath)
	if err != nil {
		return nil, fmt.Errorf("access denied or IO error: %v", err)
	}

	now := time.Now()
	var files []model.FileInfo

	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil {
			continue
		}

		// 跳过目录（logViewer 只关心文件）
		if entry.IsDir() {
			continue
		}

		fullPath := filepath.Join(absPath, entry.Name())

		// 文件名匹配
		if pattern != "" && !strings.Contains(strings.ToLower(entry.Name()), strings.ToLower(pattern)) {
			continue
		}

		// 天数过滤：只保留最近 N 天修改的文件
		modTime := info.ModTime()
		if days > 0 && now.Sub(modTime) > time.Duration(days)*24*time.Hour {
			continue
		}

		fileInfo := model.FileInfo{
			Name:         entry.Name(),
			Path:         fullPath,
			IsDirectory:  false,
			Size:         fmt.Sprintf("%d", info.Size()),
			LastModified: formatTime(modTime),
		}
		files = append(files, fileInfo)
	}

	// 按最后修改时间降序排序
	sort.Slice(files, func(i, j int) bool {
		return files[i].LastModified > files[j].LastModified
	})

	return files, nil
}
