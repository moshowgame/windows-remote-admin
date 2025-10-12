package com.softdev.system.controller;

import com.softdev.system.entity.ShellRequest;
import com.softdev.system.service.PowerShellService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpSession;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.ModelAndView;

import java.io.IOException;
import java.util.Date;

@Slf4j
@RestController
public class PowershellController {

    @Autowired
    PowerShellService powerShellService;

    @GetMapping("/shell")
    public ModelAndView shell() {
        return new ModelAndView("powershell");
    }

    @PostMapping("execute")
    public String execute(@RequestBody ShellRequest shellRequest, HttpServletRequest request) throws IOException, InterruptedException {
        shellRequest.setExecutionTime(new Date());
        shellRequest.setExecutionType("PowerShell");
        //从session里面获取用户名和单据号，注入实体中
        HttpSession session = request.getSession(false);
        shellRequest.setUserName(session.getAttribute("entitledUser")+"");
        shellRequest.setTicketNumber(session.getAttribute("ticketNumber")+"");
        log.info("Audit Log - Shell Execution ：{}", shellRequest);
        if(shellRequest.getEncoding()==null){
            shellRequest.setEncoding("UTF-8");
        }
        return powerShellService.executeCommand(shellRequest.getCommand(),shellRequest.getEncoding());
    }
}
