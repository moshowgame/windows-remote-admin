package middleware

import (
	"net/http"

	"github.com/gin-contrib/sessions"
	"github.com/gin-gonic/gin"

	"windows-remote-admin-go/internal/logger"
)

func AuthRequired() gin.HandlerFunc {
	return func(c *gin.Context) {
		path := c.Request.URL.Path

		if path == "/" || path == "/login" || path == "/favicon.ico" ||
			path == "/static/" || isStaticResource(path) {
			c.Next()
			return
		}

		session := sessions.Default(c)
		user := session.Get("entitledUser")

		if user != nil {
			c.Set("entitledUser", user)
			c.Set("purpose", session.Get("purpose"))
			c.Next()
			return
		}

		logger.Audit("未授权访问被拦截",
			"path", path,
			"method", c.Request.Method,
			"ip", c.ClientIP(),
		)

		if isAjaxRequest(c) {
			c.JSON(http.StatusUnauthorized, gin.H{
				"code": 401,
				"msg":  "未授权访问，请先登录",
				"data": nil,
			})
			c.Abort()
			return
		}

		c.Redirect(http.StatusFound, "/login")
		c.Abort()
	}
}

func isStaticResource(path string) bool {
	staticPrefixes := []string{
		"/static/", "/js/", "/css/", "/images/", "/webfonts/",
		"/bootstrap/", "/font-awesome/", "/jquery/", "/ace/", "/codemirror/",
	}

	for _, prefix := range staticPrefixes {
		if stringsHasPrefix(path, prefix) {
			return true
		}
	}
	return false
}

func isAjaxRequest(c *gin.Context) bool {
	return c.GetHeader("X-Requested-With") == "XMLHttpRequest" ||
		c.GetHeader("Content-Type") == "application/json" ||
		c.Request.Method == "POST"
}

func stringsHasPrefix(s, prefix string) bool {
	return len(s) >= len(prefix) && s[:len(prefix)] == prefix
}
