package handler

import (
	"github.com/gin-contrib/sessions"
	"github.com/gin-gonic/gin"

	"windows-remote-admin-go/internal/logger"
	"windows-remote-admin-go/internal/model"
	"windows-remote-admin-go/internal/service"
)

type PowerShellHandler struct {
	psService *service.PowerShellService
}

func NewPowerShellHandler() *PowerShellHandler {
	return &PowerShellHandler{
		psService: service.GetPowerShellService(),
	}
}

func (h *PowerShellHandler) PowerShellPage(c *gin.Context) {
	c.HTML(200, "powershell.html", nil)
}

func (h *PowerShellHandler) Execute(c *gin.Context) {
	var req model.ShellRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.String(500, "Error: Invalid request format")
		return
	}

	if req.Encoding == "" {
		req.Encoding = "UTF-8"
	}

	session := sessions.Default(c)
	user, _ := session.Get("entitledUser").(string)
	purpose, _ := session.Get("purpose").(string)
	clientIP := c.ClientIP()

	logger.Audit("PowerShell 命令执行",
		"username", user,
		"purpose", purpose,
		"ip", clientIP,
		"command", req.Command,
		"encoding", req.Encoding,
	)

	output, err := h.psService.ExecuteCommand(req.Command, req.Encoding)
	if err != nil {
		logger.Errorf("PowerShell 执行失败: %v", err)
		c.String(500, "Error: %s", err.Error())
		return
	}

	c.Header("Content-Type", "text/plain; charset=utf-8")
	c.String(200, output)
}
