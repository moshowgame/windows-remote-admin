package handler

import (
	"net/http"
	"strings"

	"github.com/gin-contrib/sessions"
	"github.com/gin-gonic/gin"

	"windows-remote-admin-go/internal/logger"
	"windows-remote-admin-go/internal/model"
	"windows-remote-admin-go/internal/service"
	"windows-remote-admin-go/internal/util"
)

type AuthHandler struct {
	entitlementSvc *service.EntitlementService
}

func NewAuthHandler(entitlementSvc *service.EntitlementService) *AuthHandler {
	return &AuthHandler{entitlementSvc: entitlementSvc}
}

func (h *AuthHandler) LoginPage(c *gin.Context) {
	c.HTML(http.StatusOK, "login.html", gin.H{
		"title": "Windows Remote Admin",
	})
}

func (h *AuthHandler) LandingPage(c *gin.Context) {
	c.HTML(http.StatusOK, "landing.html", nil)
}

func (h *AuthHandler) Login(c *gin.Context) {
	var entity model.Entitlement
	if err := c.ShouldBindJSON(&entity); err != nil {
		util.Fail(c, util.StatusBadRequest, "请求参数格式错误")
		return
	}

	if strings.TrimSpace(entity.Username) == "" ||
		strings.TrimSpace(entity.Password) == "" ||
		strings.TrimSpace(entity.Purpose) == "" {
		util.Fail(c, util.StatusBadRequest, "账号、密码、使用目的不能为空")
		return
	}

	if h.entitlementSvc.Authenticate(entity.Username, entity.Password) {
		session := sessions.Default(c)
		session.Set("entitledUser", entity.Username)
		session.Set("purpose", entity.Purpose)
		session.Options(sessions.Options{
			MaxAge:   86400,
			Path:     "/",
			HttpOnly: true,
		})
		if err := session.Save(); err != nil {
			logger.Errorf("Failed to save session: %v", err)
		}

		c.SetCookie("sre_user", entity.Username, 86400, "/", "", false, true)
		c.SetCookie("sre_purpose", entity.Purpose, 86400, "/", "", false, true)

		logger.Audit("用户登录成功",
			"username", entity.Username,
			"purpose", entity.Purpose,
			"ip", c.ClientIP(),
		)

		util.SuccessWithMsg(c, "登录成功", "登录成功")
		return
	}

	logger.Audit("用户登录失败",
		"username", entity.Username,
		"ip", c.ClientIP(),
	)
	util.Fail(c, util.StatusUnauthorized, "账号或密码错误")
}

func (h *AuthHandler) Logout(c *gin.Context) {
	session := sessions.Default(c)
	session.Clear()
	session.Options(sessions.Options{MaxAge: -1})
	session.Save()

	user, _ := session.Get("entitledUser").(string)
	logger.Audit("用户登出", "username", user, "ip", c.ClientIP())

	util.Success(c, nil)
}
