package middleware

import (
	"net/http"

	"github.com/gin-contrib/sessions"
	"github.com/gin-gonic/gin"
)

// AuthRequired 认证中间件 - 要求用户已登录
func AuthRequired() gin.HandlerFunc {
	return func(c *gin.Context) {
		// 白名单路径
		path := c.Request.URL.Path

		// 允许未登录访问的路径
		if path == "/" || path == "/login" || path == "/favicon.ico" ||
			path == "/static/" || isStaticResource(path) {
			c.Next()
			return
		}

		// 检查 Session
		session := sessions.Default(c)
		user := session.Get("entitledUser")

		if user != nil {
			c.Set("entitledUser", user)
			c.Set("purpose", session.Get("purpose"))
			c.Next()
			return
		}

		// 未登录
		if isAjaxRequest(c) {
			c.JSON(http.StatusUnauthorized, gin.H{
				"code": 401,
				"msg":  "未授权访问，请先登录",
				"data": nil,
			})
			c.Abort()
			return
		}

		// 页面请求重定向到登录页
		c.Redirect(http.StatusFound, "/login")
		c.Abort()
	}
}

// isStaticResource 判断是否为静态资源请求
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

// isAjaxRequest 判断是否为 AJAX 请求
func isAjaxRequest(c *gin.Context) bool {
	return c.GetHeader("X-Requested-With") == "XMLHttpRequest" ||
		c.GetHeader("Content-Type") == "application/json" ||
		c.Request.Method == "POST"
}

// stringsHasPrefix 自定义前缀检查
func stringsHasPrefix(s, prefix string) bool {
	return len(s) >= len(prefix) && s[:len(prefix)] == prefix
}
