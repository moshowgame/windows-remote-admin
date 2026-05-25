package model

// Entitlement 登录请求
type Entitlement struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Purpose  string `json:"purpose"`
}

// ShellRequest PowerShell 执行请求
type ShellRequest struct {
	Command       string `json:"command"`
	UserName      string `json:"userName"`
	ExecutionType string `json:"executionType"`
	Purpose       string `json:"purpose"`
	Encoding      string `json:"encoding"`
	ClientIP      string `json:"clientIpAddress"`
}

// FileRequest 文件操作请求
type FileRequest struct {
	FilePath        string `json:"filePath"`
	UserName        string `json:"userName"`
	ExecutionType   string `json:"executionType"`
	FileNamePattern string `json:"fileNamePattern"`
	KeyWord         string `json:"keyWord"`
	Purpose         string `json:"purpose"`
	Days            string `json:"days"`
	ClientIP        string `json:"clientIpAddress"`
}

// FileInfo 文件信息
type FileInfo struct {
	Name         string `json:"name"`
	Path         string `json:"path"`
	IsDirectory  bool   `json:"directory"`
	Size         string `json:"size"`
	LastModified string `json:"lastModified"`
}
