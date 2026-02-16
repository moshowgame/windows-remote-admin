package com.softdev.system.util;

import com.alibaba.fastjson2.JSON;
import com.softdev.system.entity.ShellRequest;
import com.softdev.system.entity.FileRequest;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpSession;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang3.StringUtils;
import java.util.Date;

@Slf4j
public class AuditUtil {
    
    /**
     * 从请求中获取审计信息并填充到ShellRequest
     */
    public static void writeAuditLog(ShellRequest shellRequest, HttpServletRequest request) {
        shellRequest.setExecutionTime(new Date());
        shellRequest.setExecutionType("PowerShell");
        shellRequest.setClientIpAddress(getClientIpAddress(request));
        
        // 统一获取用户信息
        UserInfo userInfo = getUserInfoFromSessionOrCookie(request);
        shellRequest.setUserName(userInfo.getUserName());
        shellRequest.setPurpose(userInfo.getPurpose());
        
        log.info("AuditLog4Powershell:{}", JSON.toJSONString(shellRequest));
    }
    
    /**
     * 从请求中获取审计信息并填充到FileRequest
     */
    public static void populateAuditInfo(FileRequest fileRequest, HttpServletRequest request) {
        fileRequest.setExecutionTime(new Date());
        fileRequest.setClientIpAddress(getClientIpAddress(request));
        
        // 统一获取用户信息
        UserInfo userInfo = getUserInfoFromSessionOrCookie(request);
        fileRequest.setUserName(userInfo.getUserName());
        fileRequest.setPurpose(userInfo.getPurpose());
    }
    
    /**
     * 统一从Session或Cookie获取用户信息
     */
    public static UserInfo getUserInfoFromSessionOrCookie(HttpServletRequest request) {
        UserInfo userInfo = new UserInfo();
        
        // 首先尝试从Session获取
        HttpSession session = request.getSession(false);
        if (session != null) {
            Object userObj = session.getAttribute("entitledUser");
            Object purposeObj = session.getAttribute("purpose");
            
            if (userObj != null) {
                userInfo.setUserName(userObj.toString());
            }
            if (purposeObj != null) {
                userInfo.setPurpose(purposeObj.toString());
            }
        }
        
        // 如果Session中没有，则尝试从Cookie获取
        if (StringUtils.isBlank(userInfo.getUserName()) || StringUtils.isBlank(userInfo.getPurpose())) {
            Cookie[] cookies = request.getCookies();
            if (cookies != null) {
                String userName = null;
                String purpose = null;
                
                for (Cookie cookie : cookies) {
                    if ("sre_user".equals(cookie.getName()) && 
                        StringUtils.isNotBlank(cookie.getValue())) {
                        userName = cookie.getValue();
                    }
                    if ("sre_purpose".equals(cookie.getName()) && 
                        StringUtils.isNotBlank(cookie.getValue())) {
                        purpose = cookie.getValue();
                    }
                }
                
                // 如果Cookie中有有效信息，重建Session
                if (StringUtils.isNotBlank(userName) && StringUtils.isNotBlank(purpose)) {
                    HttpSession newSession = request.getSession(true);
                    newSession.setAttribute("entitledUser", userName);
                    newSession.setAttribute("purpose", purpose);
                    newSession.setMaxInactiveInterval(24 * 60 * 60); // 24小时
                    
                    userInfo.setUserName(userName);
                    userInfo.setPurpose(purpose);
                }
            }
        }
        
        return userInfo;
    }
    
    /**
     * 用户信息封装类
     */
    public static class UserInfo {
        private String userName = "";
        private String purpose = "";
        
        // getters and setters
        public String getUserName() {
            return userName;
        }
        
        public void setUserName(String userName) {
            this.userName = userName != null ? userName : "";
        }
        
        public String getPurpose() {
            return purpose;
        }
        
        public void setPurpose(String purpose) {
            this.purpose = purpose != null ? purpose : "";
        }
    }
    /**
     * 获取客户端真实IP地址
     */
    private static String getClientIpAddress(HttpServletRequest request) {
        String xip = request.getHeader("X-Real-IP");
        String xfor = request.getHeader("X-Forwarded-For");
        if (xfor != null && !xfor.isEmpty() && !"unknown".equalsIgnoreCase(xfor)) {
            //多次反向代理后会有多个ip值，第一个ip才是真实ip
            int index = xfor.indexOf(",");
            if (index != -1) {
                return xfor.substring(0, index);
            } else {
                return xfor;
            }
        }
        if (xip != null && !xip.isEmpty() && !"unknown".equalsIgnoreCase(xip)) {
            return xip;
        }
        String remoteAddr = request.getRemoteAddr();
        if (remoteAddr != null) {
            return remoteAddr;
        }
        return "unknown";
    }
}
