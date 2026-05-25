package handler

import (
	"log"

	"github.com/gin-contrib/sessions"
	"github.com/gin-gonic/gin"

	"windows-remote-admin-go/internal/model"
	"windows-remote-admin-go/internal/service"
)

// PowerShellHandler PowerShell 执行处理器
type PowerShellHandler struct {
	psService *service.PowerShellService
}

// NewPowerShellHandler 创建 PowerShellHandler
func NewPowerShellHandler() *PowerShellHandler {
	return &PowerShellHandler{
		psService: service.GetPowerShellService(),
	}
}

// PowerShellPage PowerShell ISE 页面
func (h *PowerShellHandler) PowerShellPage(c *gin.Context) {
	c.HTML(200, "powershell.html", nil)
}

// Execute 执行 PowerShell 命令
func (h *PowerShellHandler) Execute(c *gin.Context) {
	var req model.ShellRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.String(500, "Error: Invalid request format")
		return
	}

	// 设置默认编码
	if req.Encoding == "" {
		req.Encoding = "UTF-8"
	}

	// 记录审计日志
	session := sessions.Default(c)
	user, _ := session.Get("entitledUser").(string)
	purpose, _ := session.Get("purpose").(string)
	clientIP := c.ClientIP()

	log.Printf("Audit Log - PowerShell Execution | User: %s | Purpose: %s | IP: %s | Command: %s",
		user, purpose, clientIP, req.Command)

	// 执行命令
	output, err := h.psService.ExecuteCommand(req.Command, req.Encoding)
	if err != nil {
		c.String(500, "Error: %s", err.Error())
		return
	}

	// 直接返回字符串（与 Java 版本保持一致）
	c.Header("Content-Type", "text/plain; charset=utf-8")
	c.String(200, output)
}
