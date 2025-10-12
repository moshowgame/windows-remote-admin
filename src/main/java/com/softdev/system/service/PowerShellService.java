package com.softdev.system.service;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import com.profesorfalken.jpowershell.PowerShell;
import com.profesorfalken.jpowershell.PowerShellResponse;

import java.io.IOException;

@Slf4j
@Service
public class PowerShellService {

    public String executeCommand(String command, String encoding) throws IOException, InterruptedException {
        StringBuilder output = new StringBuilder();
        
        try (PowerShell powerShell = PowerShell.openSession()) {
            // 处理多行脚本
            String[] lines = command.split("\n");
            PowerShellResponse response;
            
            if (lines.length > 1) {
                // 多行脚本模式
                response = powerShell.executeCommand(command);
            } else {
                // 单行命令模式
                response = powerShell.executeCommand(command);
            }
            
            if (response.isError()) {
                output.append("Error: ").append(response.getCommandOutput());
            } else {
                output.append(response.getCommandOutput());
            }
        } catch (Exception e) {
            log.error("PowerShell execution error: ", e);
            output.append("Error executing PowerShell command: ").append(e.getMessage());
        }
        
        return output.toString();
    }
}