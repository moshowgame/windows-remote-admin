package main

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-contrib/sessions"
	"github.com/gin-contrib/sessions/cookie"
	"github.com/gin-gonic/gin"

	"windows-remote-admin-go/internal/config"
	"windows-remote-admin-go/internal/handler"
	"windows-remote-admin-go/internal/logger"
	"windows-remote-admin-go/internal/middleware"
	"windows-remote-admin-go/internal/service"
)

func main() {
	// ========== 初始化日志系统 ==========
	logger.Init("logs")
	defer logger.Sync()

	cfg := config.DefaultConfig()

	gin.SetMode(gin.ReleaseMode)

	engine := gin.New()
	engine.Use(gin.LoggerWithWriter(logger.GetGinWriter()))
	engine.Use(gin.Recovery())

	engine.LoadHTMLGlob("web/templates/*")
	engine.Static("/static", "./web/static")

	store := cookie.NewStore([]byte(cfg.SessionKey))
	store.Options(sessions.Options{
		Path:     "/",
		MaxAge:   86400,
		HttpOnly: true,
	})
	engine.Use(sessions.Sessions("wra_session", store))

	csvPath := cfg.CSVPath
	if _, err := os.Stat(csvPath); os.IsNotExist(err) {
		csvPath = filepath.Join("data", "entitlement.csv")
	}
	entitlementSvc := service.GetEntitlementServiceWithFS(csvPath, &dataFS)

	authHandler := handler.NewAuthHandler(entitlementSvc)
	psHandler := handler.NewPowerShellHandler()
	fileHandler := handler.NewFileHandler()

	// ---- 路由注册 ----

	engine.GET("/", func(c *gin.Context) {
		c.Redirect(http.StatusFound, "/login")
	})
	engine.GET("/login", authHandler.LoginPage)
	engine.POST("/login", authHandler.Login)

	pages := engine.Group("/")
	pages.Use(middleware.AuthRequired())
	{
		pages.GET("/landing", authHandler.LandingPage)
		pages.GET("/console/powershell", psHandler.PowerShellPage)
		pages.GET("/explorer", fileHandler.FilePage)
		pages.GET("/texteditor", fileHandler.TextViewerPage)
		pages.GET("/logmonitor", fileHandler.LogViewerPage)
	}

	api := engine.Group("/")
	api.Use(middleware.AuthRequired())
	{
		api.POST("/execute", psHandler.Execute)
		api.POST("/list", fileHandler.ListFiles)
		api.POST("/listPlus", fileHandler.ListFilesPlus)
		api.POST("/download", fileHandler.DownloadFile)
		api.POST("/normalizedPath", fileHandler.NormalizePath)
		api.POST("/read", fileHandler.ReadFile)
		api.POST("/upload", fileHandler.UploadFile)
		api.POST("/logout", authHandler.Logout)
	}

	addr := fmt.Sprintf(":%s", cfg.Port)
	logger.Infof(strings.Repeat("=", 60))
	logger.Infof("  Windows Remote Admin (Go Edition)")
	logger.Infof("  Portable Windows Management Tool")
	logger.Infof("  Port: %s", cfg.Port)
	logger.Infof("  URL:  http://localhost%s/", addr)
	logger.Infof("  GitHub: https://github.com/moshowgame/windows-remote-admin")
	logger.Infof(strings.Repeat("=", 60))

	if err := engine.Run(addr); err != nil {
		logger.Errorf("Failed to start server: %v", err)
		os.Exit(1)
	}
}
