package util

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// StatusCode 状态码
type StatusCode struct {
	Code       int
	DefaultMsg string
}

var (
	StatusSuccess      = StatusCode{200, "操作成功"}
	StatusBadRequest   = StatusCode{400, "请求参数错误"}
	StatusUnauthorized = StatusCode{401, "未授权访问"}
	StatusForbidden    = StatusCode{403, "禁止访问"}
	StatusNotFound     = StatusCode{404, "资源不存在"}
	StatusInternalErr  = StatusCode{500, "服务器内部错误"}
)

// ResponseResult 统一响应结构
type ResponseResult struct {
	Code int         `json:"code"`
	Msg  string      `json:"msg"`
	Data interface{} `json:"data"`
}

// Success 成功响应（带数据）
func Success(c *gin.Context, data interface{}) {
	c.JSON(http.StatusOK, ResponseResult{
		Code: StatusSuccess.Code,
		Msg:  StatusSuccess.DefaultMsg,
		Data: data,
	})
}

// SuccessWithMsg 成功响应（自定义消息）
func SuccessWithMsg(c *gin.Context, data interface{}, msg string) {
	c.JSON(http.StatusOK, ResponseResult{
		Code: StatusSuccess.Code,
		Msg:  msg,
		Data: data,
	})
}

// Fail 失败响应
func Fail(c *gin.Context, sc StatusCode, msg string) {
	httpStatus := http.StatusBadRequest
	switch sc.Code {
	case StatusUnauthorized.Code:
		httpStatus = http.StatusUnauthorized
	case StatusForbidden.Code:
		httpStatus = http.StatusForbidden
	case StatusInternalErr.Code:
		httpStatus = http.StatusInternalServerError
	}
	c.JSON(httpStatus, ResponseResult{
		Code: sc.Code,
		Msg:  msg,
		Data: nil,
	})
}
