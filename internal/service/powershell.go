package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"os/exec"
	"strings"
	"unicode/utf16"
	"time"
)

// PowerShellService PowerShell 执行服务
type PowerShellService struct{}

var psService *PowerShellService

// GetPowerShellService 获取 PowerShellService 单例
func GetPowerShellService() *PowerShellService {
	if psService == nil {
		psService = &PowerShellService{}
	}
	return psService
}

// ExecuteCommand 执行 PowerShell 命令
func (s *PowerShellService) ExecuteCommand(command, encoding string) (string, error) {
	// 使用 60 秒超时
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// 清理命令中的 \r，统一为 \n，避免干扰 Base64 编码
	command = strings.ReplaceAll(command, "\r\n", "\n")
	command = strings.ReplaceAll(command, "\r", "\n")

	// 构建完整脚本：抑制进度/CLIXML噪声，设置编码，执行用户命令
	encName := strings.ReplaceAll(encoding, "-", "")
	script := fmt.Sprintf(`$ProgressPreference='SilentlyContinue'; $VerbosePreference='SilentlyContinue'; $ErrorActionPreference='Stop'; $OutputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::%s; %s`, encName, command)

	// 使用 -EncodedCommand 避免 shell 特殊字符（$ {} () 等）被二次解析
	encodedCmd := encodeToBase64(script)
	cmd := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCmd)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()

	// 获取输出，清理 CLIXML 垃圾
	output := cleanOutput(stdout.String())
	errOutput := cleanOutput(stderr.String())

	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return "", fmt.Errorf("command execution timed out after 60 seconds")
		}
		if errOutput != "" {
			return fmt.Sprintf("Error: %s", errOutput), nil
		}
		if output != "" {
			return output, nil
		}
		// exit status 1 等情况：把 stderr 和 stdout 都带上，方便排查
		rawStdout := strings.TrimSpace(stdout.String())
		rawStderr := strings.TrimSpace(stderr.String())
		detail := rawStderr
		if detail != "" && rawStdout != "" {
			detail = detail + "\n" + rawStdout
		} else if detail == "" && rawStdout != "" {
			detail = rawStdout
		}
		if detail == "" {
			detail = fmt.Sprintf("exit status %s", extractExitCode(err))
		}
		return fmt.Sprintf("Error: %s", detail), nil
	}

	if output == "" && errOutput == "" {
		return "Command executed successfully. No output returned.", nil
	}

	result := strings.TrimSpace(output)
	if errOutput != "" {
		result += "\n[Stderr]: " + strings.TrimSpace(errOutput)
	}
	if result == "" {
		return "Command executed successfully. No output returned.", nil
	}

	return result, nil
}

// cleanOutput 清理 PowerShell 输出中的 CLIXML 和进度噪声
func cleanOutput(raw string) string {
	lines := strings.Split(raw, "\n")
	var cleaned []string
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		// 跳过空行、CLIXML 标记、进度输出
		if trimmed == "" ||
			strings.HasPrefix(trimmed, "#< CLIXML") ||
			strings.HasPrefix(trimmed, "#<") ||
			strings.HasSuffix(trimmed, "</CLIXML>") ||
			strings.Contains(trimmed, "<Objs ") ||
			strings.Contains(trimmed, "<S ") ||
			strings.Contains(trimmed, "<Obj ") ||
			strings.Contains(trimmed, "</Objs>") ||
			strings.Contains(trimmed, "</S>") ||
			strings.Contains(trimmed, "</Obj>") ||
			trimmed == "Completed" ||
			strings.HasPrefix(trimmed, "Preparing modules") {
			continue
		}
		cleaned = append(cleaned, line)
	}
	return strings.Join(cleaned, "\n")
}

// encodeToBase64 将字符串编码为 PowerShell -EncodedCommand 所需的 Base64 (UTF-16LE)
func encodeToBase64(s string) string {
	runes := []rune(s)
	u16 := utf16.Encode(runes)
	buf := make([]byte, len(u16)*2)
	for i, r := range u16 {
		buf[i*2] = byte(r)
		buf[i*2+1] = byte(r >> 8)
	}
	return base64.StdEncoding.EncodeToString(buf)
}

// extractExitCode 从 exec.ExitError 中提取退出码
func extractExitCode(err error) string {
	if exitErr, ok := err.(*exec.ExitError); ok {
		return fmt.Sprintf("%d", exitErr.ExitCode())
	}
	return fmt.Sprintf("%v", err)
}
