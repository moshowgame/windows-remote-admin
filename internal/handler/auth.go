package handler

import (
	"log"
	"net/http"
	"strings"

	"github.com/gin-contrib/sessions"
	"github.com/gin-gonic/gin"

	"windows-remote-admin-go/internal/model"
	"windows-remote-admin-go/internal/service"
	"windows-remote-admin-go/internal/util"
)

// AuthHandler 认证相关处理器
type AuthHandler struct {
	entitlementSvc *service.EntitlementService
}

// NewAuthHandler 创建 AuthHandler
func NewAuthHandler(entitlementSvc *service.EntitlementService) *AuthHandler {
	return &AuthHandler{entitlementSvc: entitlementSvc}
}

// LoginPage 登录页面
func (h *AuthHandler) LoginPage(c *gin.Context) {
	c.HTML(http.StatusOK, "login.html", gin.H{
		"title": "Windows Remote Admin",
	})
}

// LandingPage 着陆页
func (h *AuthHandler) LandingPage(c *gin.Context) {
	c.HTML(http.StatusOK, "landing.html", nil)
}

// Login 处理登录请求
func (h *AuthHandler) Login(c *gin.Context) {
	var entity model.Entitlement
	if err := c.ShouldBindJSON(&entity); err != nil {
		util.Fail(c, util.StatusBadRequest, "请求参数格式错误")
		return
	}

	// 校验非空
	if strings.TrimSpace(entity.Username) == "" ||
		strings.TrimSpace(entity.Password) == "" ||
		strings.TrimSpace(entity.Purpose) == "" {
		util.Fail(c, util.StatusBadRequest, "账号、密码、使用目的不能为空")
		return
	}

	// 认证
	if h.entitlementSvc.Authenticate(entity.Username, entity.Password) {
		// 保存 Session
		session := sessions.Default(c)
		session.Set("entitledUser", entity.Username)
		session.Set("purpose", entity.Purpose)
		session.Options(sessions.Options{
			MaxAge:   86400, // 24小时
			Path:     "/",
			HttpOnly: true,
		})
		if err := session.Save(); err != nil {
			log.Printf("Failed to save session: %v", err)
		}

		// 设置 Cookies（保持与 Java 版本一致）
		c.SetCookie("sre_user", entity.Username, 86400, "/", "", false, true)
		c.SetCookie("sre_purpose", entity.Purpose, 86400, "/", "", false, true)

		log.Printf("用户登录成功: %s, 使用目的: %s", entity.Username, entity.Purpose)

		util.SuccessWithMsg(c, "登录成功", "登录成功")
		return
	}

	log.Printf("用户登录失败: %s", entity.Username)
	util.Fail(c, util.StatusUnauthorized, "账号或密码错误")
}

// Logout 处理登出请求
func (h *AuthHandler) Logout(c *gin.Context) {
	session := sessions.Default(c)
	session.Clear()
	session.Options(sessions.Options{MaxAge: -1})
	session.Save()

	util.Success(c, nil)
}
