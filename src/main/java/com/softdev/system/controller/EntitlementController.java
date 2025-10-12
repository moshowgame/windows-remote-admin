package com.softdev.system.controller;

import com.softdev.system.entity.Entitlement;
import com.softdev.system.service.EntitlementService;
import com.softdev.system.util.AESUtil;
import com.softdev.system.util.ResponseUtil;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpSession;
import org.apache.commons.lang3.StringUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.ModelAndView;

@RestController
public class EntitlementController {

    @Autowired
    private EntitlementService entitlementService;

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
    @PostMapping("/entitlement")
    public Object entitlement(@RequestBody Entitlement entity, HttpServletRequest request,
                              HttpServletResponse response) throws Exception {
        if(StringUtils.isAnyBlank(entity.getUserName(), entity.getToken(), entity.getTicketNumber())){
            return ResponseUtil.fail(ResponseUtil.StatusCode.BAD_REQUEST,"username | token | ticket cannot be null");
        }
        // 调用认证服务
        // 认证成功后设置Cookie
        if(entitlementService.authenticate(entity.getToken())) { // 根据你的实际认证结果判断
            // 获取Session并存储用户信息
            HttpSession session = request.getSession();
            session.setAttribute("entitledUser", entity.getUserName());
            session.setAttribute("ticketNumber", entity.getTicketNumber());
            // 设置Session过期时间（4H）
            session.setMaxInactiveInterval(4 * 60 * 60); // 单位：秒

            return ResponseUtil.success(entity.getUserName());
        }else{
            return ResponseUtil.fail(ResponseUtil.StatusCode.UNAUTHORIZED);
        }
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