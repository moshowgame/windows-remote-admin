package config

import (
	"os"
)

// Config 应用配置
type Config struct {
	Port       string
	AESKey     string
	CSVPath    string
	SessionKey string
}

// DefaultConfig 返回默认配置
func DefaultConfig() *Config {
	port := os.Getenv("WRA_PORT")
	if port == "" {
		port = "12306"
	}

	aesKey := os.Getenv("WRA_AES_KEY")
	if aesKey == "" {
		aesKey = "WRA12306"
	}

	sessionKey := os.Getenv("WRA_SESSION_KEY")
	if sessionKey == "" {
		sessionKey = "windows-remote-admin-session-secret-key-2026"
	}

	return &Config{
		Port:       port,
		AESKey:     aesKey,
		CSVPath:    "data/entitlement.csv",
		SessionKey: sessionKey,
	}
}
