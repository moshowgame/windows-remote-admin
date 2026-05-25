package logger

import (
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"gopkg.in/natefinch/lumberjack.v2"
)

var (
	appLogger   *zap.SugaredLogger
	auditLogger *zap.SugaredLogger
	ginWriter   io.Writer
	initOnce    sync.Once
	baseDir     string // 可执行文件所在目录
)

// Init 初始化日志系统
// logDir: 日志文件存放目录（默认 "logs"，相对于 exe 所在目录）
func Init(logDir string) {
	initOnce.Do(func() {
		// 获取可执行文件所在目录（确保日志始终输出到 exe 旁边）
		exePath, err := os.Executable()
		if err != nil {
			baseDir, _ = os.Getwd()
		} else {
			baseDir = filepath.Dir(exePath)
		}

		if logDir == "" {
			logDir = "logs"
		}

		// 如果 logDir 不是绝对路径，则基于 exe 目录解析为绝对路径
		if !filepath.IsAbs(logDir) {
			logDir = filepath.Join(baseDir, logDir)
		}

		// 确保日志目录存在
		if err := os.MkdirAll(logDir, 0755); err != nil {
			panic("Failed to create log directory: " + err.Error())
		}

		// ---- Application Logger (app.log) ----
		appWriter := &lumberjack.Logger{
			Filename:   filepath.Join(logDir, "app.log"),
			MaxSize:    10,
			MaxBackups: 30,
			MaxAge:     30,
			Compress:   true,
			LocalTime:  true,
		}

		// ---- Audit Logger (audit.log) ----
		auditWriter := &lumberjack.Logger{
			Filename:   filepath.Join(logDir, "audit.log"),
			MaxSize:    10,
			MaxBackups: 30,
			MaxAge:     30,
			Compress:   true,
			LocalTime:  true,
		}

		// ---- Gin Access Logger (access.log) ----
		accessWriter := &lumberjack.Logger{
			Filename:   filepath.Join(logDir, "access.log"),
			MaxSize:    10,
			MaxBackups: 30,
			MaxAge:     30,
			Compress:   true,
			LocalTime:  true,
		}

		encoderConfig := zapcore.EncoderConfig{
			TimeKey:        "time",
			LevelKey:       "level",
			NameKey:        "logger",
			CallerKey:      "caller",
			MessageKey:     "msg",
			StacktraceKey:  "stacktrace",
			LineEnding:     zapcore.DefaultLineEnding,
			EncodeLevel:    zapcore.CapitalLevelEncoder,
			EncodeTime:     customTimeEncoder,
			EncodeDuration: zapcore.SecondsDurationEncoder,
			EncodeCaller:   zapcore.ShortCallerEncoder,
		}

		consoleEncoderConfig := encoderConfig
		consoleEncoderConfig.EncodeLevel = zapcore.CapitalColorLevelEncoder

		appCore := zapcore.NewTee(
			zapcore.NewCore(zapcore.NewJSONEncoder(encoderConfig), zapcore.AddSync(appWriter), zapcore.InfoLevel),
			zapcore.NewCore(zapcore.NewConsoleEncoder(consoleEncoderConfig), zapcore.AddSync(os.Stdout), zapcore.InfoLevel),
		)

		auditCore := zapcore.NewCore(
			zapcore.NewJSONEncoder(encoderConfig),
			zapcore.AddSync(auditWriter),
			zapcore.InfoLevel,
		)

		accessCore := zapcore.NewCore(
			zapcore.NewJSONEncoder(encoderConfig),
			zapcore.AddSync(accessWriter),
			zapcore.InfoLevel,
		)

		appLogger = zap.New(appCore, zap.AddCaller(), zap.AddCallerSkip(1)).Sugar()
		auditLogger = zap.New(auditCore, zap.AddCaller()).Sugar()

		accessLogger := zap.New(accessCore, zap.AddCallerSkip(2)).Sugar()
		ginWriter = &ginLogWriter{logger: accessLogger}
	})

	appLogger.Infof("Logger initialized - log dir: %s, retention: 30 days", logDir)
}

func customTimeEncoder(t time.Time, enc zapcore.PrimitiveArrayEncoder) {
	enc.AppendString(t.Format("2006-01-02 15:04:05.000"))
}

func Info(msg string, keysAndValues ...interface{}) {
	appLogger.Infow(msg, keysAndValues...)
}

func Infof(template string, args ...interface{}) {
	appLogger.Infof(template, args...)
}

func Warn(msg string, keysAndValues ...interface{}) {
	appLogger.Warnw(msg, keysAndValues...)
}

func Warnf(template string, args ...interface{}) {
	appLogger.Warnf(template, args...)
}

func Error(msg string, keysAndValues ...interface{}) {
	appLogger.Errorw(msg, keysAndValues...)
}

func Errorf(template string, args ...interface{}) {
	appLogger.Errorf(template, args...)
}

func Debug(msg string, keysAndValues ...interface{}) {
	appLogger.Debugw(msg, keysAndValues...)
}

func Debugf(template string, args ...interface{}) {
	appLogger.Debugf(template, args...)
}

func Audit(msg string, keysAndValues ...interface{}) {
	auditLogger.Infow(msg, keysAndValues...)
}

func Auditf(template string, args ...interface{}) {
	auditLogger.Infof(template, args...)
}

func GetGinWriter() io.Writer {
	if ginWriter == nil {
		return os.Stdout
	}
	return ginWriter
}

type ginLogWriter struct {
	logger *zap.SugaredLogger
}

func (w *ginLogWriter) Write(p []byte) (n int, err error) {
	msg := string(p)
	if len(msg) > 0 && msg[len(msg)-1] == '\n' {
		msg = msg[:len(msg)-1]
	}
	w.logger.Info(msg)
	return len(p), nil
}

func Sync() {
	if appLogger != nil {
		appLogger.Sync()
	}
	if auditLogger != nil {
		auditLogger.Sync()
	}
}
