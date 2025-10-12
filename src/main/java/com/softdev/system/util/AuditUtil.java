package com.softdev.system.util;

import com.alibaba.fastjson2.JSON;
import com.softdev.system.entity.ShellRequest;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpSession;
import lombok.extern.slf4j.Slf4j;
import java.util.Date;

@Slf4j
public class AuditUtil {
    public static void writeAuditLog(ShellRequest shellRequest, HttpServletRequest request) {
        shellRequest.setExecutionTime(new Date());
        shellRequest.setExecutionType("PowerShell");
        shellRequest.setClientIpAddress(getClientIpAddress(request));
        //从session里面获取用户名和单据号，注入实体中
        HttpSession session = request.getSession(false);
        shellRequest.setUserName(session.getAttribute("entitledUser")+"");
        shellRequest.setTicketNumber(session.getAttribute("ticketNumber")+"");
        log.info("AuditLog4Powershell:{}", JSON.toJSONString(shellRequest));
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
