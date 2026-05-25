package service

import (
	"embed"
	"encoding/csv"
	"fmt"
	"io"
	iofs "io/fs"
	"os"
	"strings"
	"sync"
)

// EntitlementService 用户认证服务
type EntitlementService struct {
	mu      sync.RWMutex
	userMap map[string]string
	loaded  bool
}

var entitlementService *EntitlementService
var entitlementOnce sync.Once

// GetEntitlementService 获取 EntitlementService 单例
func GetEntitlementService(csvPath string) *EntitlementService {
	return GetEntitlementServiceWithFS(csvPath, nil)
}

// GetEntitlementServiceWithFS 获取 EntitlementService 单例（支持嵌入文件系统）
func GetEntitlementServiceWithFS(csvPath string, embedFS *embed.FS) *EntitlementService {
	entitlementOnce.Do(func() {
		entitlementService = &EntitlementService{
			userMap: make(map[string]string),
		}
	})
	entitlementService.init(csvPath, embedFS)
	return entitlementService
}

// init 从 CSV 文件加载用户凭据
func (s *EntitlementService) init(csvPath string, embedFS *embed.FS) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.loaded {
		return
	}

	f, err := os.Open(csvPath)
	if err != nil {
		// 尝试从嵌入文件系统加载
		if embedFS != nil {
			fmt.Printf("Cannot open CSV at %s, trying embedded data...\n", csvPath)
			s.initFromFS(*embedFS, "entitlement.csv")
			return
		}
		fmt.Printf("Warning: Cannot open CSV at %s, no embedded data available\n", csvPath)
		return
	}
	defer f.Close()

	s.loadFromReader(f)

	s.loaded = true
	fmt.Printf("EntitlementService initialized successfully. Total users: %d\n", len(s.userMap))
}

// loadFromReader 从 io.Reader 加载 CSV 数据
func (s *EntitlementService) loadFromReader(r io.Reader) {
	reader := csv.NewReader(r)
	// 跳过表头
	_, err := reader.Read()
	if err != nil {
		fmt.Printf("Warning: Failed to read CSV header: %v\n", err)
		return
	}

	for {
		record, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			fmt.Printf("Warning: Failed to read CSV record: %v\n", err)
			continue
		}
		if len(record) >= 2 {
			username := strings.TrimSpace(record[0])
			password := strings.TrimSpace(record[1])
			s.userMap[username] = password
		}
	}
}

// initFromFS 从嵌入文件系统加载 CSV
func (s *EntitlementService) initFromFS(embedFS embed.FS, name string) {
	data, err := iofs.ReadFile(&embedFS, name)
	if err != nil {
		fmt.Printf("Warning: Failed to read embedded CSV: %v\n", err)
		return
	}
	s.loadFromReader(strings.NewReader(string(data)))
	s.loaded = true
	fmt.Printf("EntitlementService initialized from embedded data. Total users: %d\n", len(s.userMap))
}

// Authenticate 验证用户名和密码
func (s *EntitlementService) Authenticate(username, password string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if len(s.userMap) == 0 {
		return false
	}

	storedPassword, exists := s.userMap[username]
	if !exists {
		return false
	}

	return password == storedPassword
}

// HasUsers 检查是否有已加载的用户
func (s *EntitlementService) HasUsers() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.userMap) > 0
}
