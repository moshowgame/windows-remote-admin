package com.softdev.system.service;

import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang3.StringUtils;
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
            PowerShellResponse response;
            
            // 支持多行脚本模式
            response = powerShell.executeCommand(command);

            if (response.isError() && StringUtils.isNotBlank(response.getCommandOutput())) {
                //isError + error output不为空才表示有真正的error
                output.append("Error: ").append(response.getCommandOutput());
            } else {
                String commandOutput = response.getCommandOutput();
                // 如果命令执行成功但没有返回结果，则显示成功信息
                if (commandOutput == null || commandOutput.trim().isEmpty()) {
                    output.append("Command executed successfully. No output returned.");
                } else {
                    output.append(commandOutput);
                }
            }
        } catch (Exception e) {
            log.error("PowerShell execution error: ", e);
            output.append("Error executing PowerShell command: ").append(e.getMessage());
        }
        
        return output.toString();
    }
}