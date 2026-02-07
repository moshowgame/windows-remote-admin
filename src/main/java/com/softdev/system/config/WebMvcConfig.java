package com.softdev.system.config;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
public class WebMvcConfig implements WebMvcConfigurer {

    @Autowired
    private UserLoginInterceptor loginInterceptor;

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(loginInterceptor)
                .addPathPatterns("/**")
                .excludePathPatterns(
                    "/login",        // 登录页面
                    "/entitlement",  // 登录接口
                    "/execute",      // PowerShell执行接口
                    "/shell",        // PowerShell页面
                    "/images/**",    // 图片资源
                    "/js/**",        // JS文件
                    "/css/**",       // CSS文件
                    "/static/**",    // 静态资源目录
                    "/favicon.ico"   // 网站图标
                );
    }
}
