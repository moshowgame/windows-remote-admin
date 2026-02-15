package com.softdev.system.controller;

import com.softdev.system.entity.Entitlement;
import com.softdev.system.service.EntitlementService;
import com.softdev.system.util.ResponseUtil;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpSession;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang3.StringUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.ModelAndView;

@Slf4j
@RestController
public class LoginController {

    @Autowired
    private EntitlementService entitlementService;

    @GetMapping("/")
    public ModelAndView defaultPage() throws Exception {
        return new ModelAndView("login");
    }
    @GetMapping("/login")
    public ModelAndView login(HttpServletRequest request, HttpServletResponse response) throws Exception {
        return new ModelAndView("login");
    }
    @GetMapping("/landing")
    public ModelAndView landing(HttpServletRequest request, HttpServletResponse response) throws Exception {
        return new ModelAndView("landing");
    }
    /**
     * 认证
     */
    @PostMapping("/login")
    public Object logins(@RequestBody Entitlement entity, HttpServletRequest request,
                              HttpServletResponse response) throws Exception {
        if(StringUtils.isAnyBlank(entity.getUsername(), entity.getPassword(), entity.getPurpose())){
            return ResponseUtil.fail(ResponseUtil.StatusCode.BAD_REQUEST,"账号、密码、使用目的不能为空");
        }
        
        // 简单的认证逻辑（实际项目中应该连接数据库验证）
        if(authenticateUser(entity.getUsername(), entity.getPassword())) {
            // 获取Session并存储用户信息
            HttpSession session = request.getSession();
            session.setAttribute("entitledUser", entity.getUsername());
            session.setAttribute("purpose", entity.getPurpose());
            // 设置Session过期时间（24小时）
            session.setMaxInactiveInterval(24 * 60 * 60); // 单位：秒
            
            // 设置Cookie（有效期1天）
            Cookie userCookie = new Cookie("sre_user", entity.getUsername());
            userCookie.setMaxAge(24 * 60 * 60); // 24小时
            userCookie.setPath("/");
            userCookie.setHttpOnly(true);
            response.addCookie(userCookie);
            
            Cookie purposeCookie = new Cookie("sre_purpose", entity.getPurpose());
            purposeCookie.setMaxAge(24 * 60 * 60); // 24小时
            purposeCookie.setPath("/");
            purposeCookie.setHttpOnly(true);
            response.addCookie(purposeCookie);
            
            // 记录登录日志
            log.info("用户登录成功: {}, 使用目的: {}", entity.getUsername(), entity.getPurpose());
            
            return ResponseUtil.success("登录成功");
        } else {
            log.warn("用户登录失败: {}", entity.getUsername());
            return ResponseUtil.fail(ResponseUtil.StatusCode.UNAUTHORIZED, "账号或密码错误");
        }
    }
    
    /**
     * 简单的用户认证方法
     * 实际项目中应该连接数据库进行验证
     */
    private boolean authenticateUser(String username, String password) {
        return entitlementService.authenticate(username, password);
    }

    @PostMapping("/logout")
    public Object logout(HttpServletRequest request) {
        HttpSession session = request.getSession(false);
        if(session != null) {
            session.invalidate();
        }
        return ResponseUtil.success();
    }

}