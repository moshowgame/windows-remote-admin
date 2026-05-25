package service

import (
	"embed"
	"encoding/csv"
	"io"
	iofs "io/fs"
	"os"
	"strings"
	"sync"

	"windows-remote-admin-go/internal/logger"
)

type EntitlementService struct {
	mu      sync.RWMutex
	userMap map[string]string
	loaded  bool
}

var entitlementService *EntitlementService
var entitlementOnce sync.Once

func GetEntitlementService(csvPath string) *EntitlementService {
	return GetEntitlementServiceWithFS(csvPath, nil)
}

func GetEntitlementServiceWithFS(csvPath string, embedFS *embed.FS) *EntitlementService {
	entitlementOnce.Do(func() {
		entitlementService = &EntitlementService{
			userMap: make(map[string]string),
		}
	})
	entitlementService.init(csvPath, embedFS)
	return entitlementService
}

func (s *EntitlementService) init(csvPath string, embedFS *embed.FS) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.loaded {
		return
	}

	f, err := os.Open(csvPath)
	if err != nil {
		if embedFS != nil {
			logger.Warnf("Cannot open CSV at %s, trying embedded data...", csvPath)
			s.initFromFS(*embedFS, "entitlement.csv")
			return
		}
		logger.Warnf("Cannot open CSV at %s, no embedded data available", csvPath)
		return
	}
	defer f.Close()

	s.loadFromReader(f)
	s.loaded = true
	logger.Infof("EntitlementService initialized, total users: %d", len(s.userMap))
}

func (s *EntitlementService) loadFromReader(r io.Reader) {
	reader := csv.NewReader(r)
	_, err := reader.Read()
	if err != nil {
		logger.Warnf("Failed to read CSV header: %v", err)
		return
	}

	for {
		record, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			logger.Warnf("Failed to read CSV record: %v", err)
			continue
		}
		if len(record) >= 2 {
			username := strings.TrimSpace(record[0])
			password := strings.TrimSpace(record[1])
			s.userMap[username] = password
		}
	}
}

func (s *EntitlementService) initFromFS(embedFS embed.FS, name string) {
	data, err := iofs.ReadFile(&embedFS, name)
	if err != nil {
		logger.Warnf("Failed to read embedded CSV: %v", err)
		return
	}
	s.loadFromReader(strings.NewReader(string(data)))
	s.loaded = true
	logger.Infof("EntitlementService initialized from embedded data, total users: %d", len(s.userMap))
}

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

func (s *EntitlementService) HasUsers() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.userMap) > 0
}
