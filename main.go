package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-contrib/sessions"
	"github.com/gin-contrib/sessions/cookie"
	"github.com/gin-gonic/gin"

	"windows-remote-admin-go/internal/config"
	"windows-remote-admin-go/internal/handler"
	"windows-remote-admin-go/internal/middleware"
	"windows-remote-admin-go/internal/service"
)

func main() {
	// 加载配置
	cfg := config.DefaultConfig()

	// 设置 Gin 模式
	gin.SetMode(gin.ReleaseMode)

	// 创建 Gin 引擎
	engine := gin.New()
	engine.Use(gin.Logger())
	engine.Use(gin.Recovery())

	// 加载模板
	engine.LoadHTMLGlob("web/templates/*")

	// 模板函数已通过 LoadHTMLGlob 自动加载

	// 静态资源服务
	engine.Static("/static", "./web/static")

	// Session 存储
	store := cookie.NewStore([]byte(cfg.SessionKey))
	store.Options(sessions.Options{
		Path:     "/",
		MaxAge:   86400, // 24小时
		HttpOnly: true,
	})
	engine.Use(sessions.Sessions("wra_session", store))

	// 初始化服务
	csvPath := cfg.CSVPath
	// 尝试多个路径寻找 CSV
	if _, err := os.Stat(csvPath); os.IsNotExist(err) {
		csvPath = filepath.Join("data", "entitlement.csv")
	}
	entitlementSvc := service.GetEntitlementServiceWithFS(csvPath, &dataFS)

	// 创建处理器
	authHandler := handler.NewAuthHandler(entitlementSvc)
	psHandler := handler.NewPowerShellHandler()
	fileHandler := handler.NewFileHandler()

	// ---- 路由注册 ----

	// 不需要认证的页面路由
	engine.GET("/", func(c *gin.Context) {
		c.Redirect(http.StatusFound, "/login")
	})
	engine.GET("/login", authHandler.LoginPage)

	// 不需要认证的 API 路由
	engine.POST("/login", authHandler.Login)

	// 页面路由（需要认证，由中间件处理）
	pages := engine.Group("/")
	pages.Use(middleware.AuthRequired())
	{
		pages.GET("/landing", authHandler.LandingPage)
		pages.GET("/console/powershell", psHandler.PowerShellPage)
		pages.GET("/explorer", fileHandler.FilePage)
		pages.GET("/texteditor", fileHandler.TextViewerPage)
		pages.GET("/logmonitor", fileHandler.LogViewerPage)
	}

	// API 路由
	api := engine.Group("/")
	api.Use(middleware.AuthRequired())
	{
		// PowerShell
		api.POST("/execute", psHandler.Execute)

		// 文件管理
		api.POST("/list", fileHandler.ListFiles)
		api.POST("/listPlus", fileHandler.ListFilesPlus)
		api.POST("/download", fileHandler.DownloadFile)
		api.POST("/normalizedPath", fileHandler.NormalizePath)
		api.POST("/read", fileHandler.ReadFile)
		api.POST("/upload", fileHandler.UploadFile)

		// 登出
		api.POST("/logout", authHandler.Logout)
	}

	// 启动服务器
	addr := fmt.Sprintf(":%s", cfg.Port)
	log.Println(strings.Repeat("=", 60))
	log.Println("  Windows Remote Admin (Go Edition)")
	log.Println("  Portable Windows Management Tool")
	log.Printf("  Port: %s", cfg.Port)
	log.Printf("  URL:  http://localhost%s/", addr)
	log.Println("  GitHub: https://github.com/moshowgame/windows-remote-admin")
	log.Println(strings.Repeat("=", 60))

	if err := engine.Run(addr); err != nil {
		log.Fatalf("Failed to start server: %v", err)
		os.Exit(1)
	}
}
