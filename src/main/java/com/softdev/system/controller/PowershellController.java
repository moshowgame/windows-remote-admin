package com.softdev.system.controller;

import com.softdev.system.entity.ShellRequest;
import com.softdev.system.service.PowerShellService;
import com.softdev.system.util.AuditUtil;
import jakarta.servlet.http.HttpServletRequest;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.ModelAndView;

import java.io.IOException;

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

        if(shellRequest.getEncoding()==null){
            shellRequest.setEncoding("UTF-8");
        }
        AuditUtil.writeAuditLog(shellRequest,request);
        return powerShellService.executeCommand(shellRequest.getCommand(),shellRequest.getEncoding());
    }
}