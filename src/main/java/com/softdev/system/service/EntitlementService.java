package com.softdev.system.service;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;
@Slf4j
@Service
public class EntitlementService {
    private final Map<String, String> tokenMap = new HashMap<>();

    private void init() {
        try {
            // 从资源文件夹中读取 tokens.csv
            BufferedReader reader = new BufferedReader(
                    new InputStreamReader(Objects.requireNonNull(getClass().getResourceAsStream("/data/entitlement.csv")), StandardCharsets.UTF_8)
            );

            String line;
            reader.readLine(); // 跳过表头
            while ((line = reader.readLine()) != null) {
                // 按照逗号分割每一行
                String[] tokens = line.split(",");
                if (tokens.length >= 2) {
                    String username = tokens[0].trim();
                    String token = tokens[1].trim();
                    tokenMap.put(token, "admin");
                }
            }
            reader.close();

            log.info("EntitlementService initialized successfully. total {}", tokenMap.size());
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    public boolean authenticate(String token) {
        if (tokenMap.isEmpty()) {
            init();
        }
        // 验证用户名和Token是否匹配
        return "admin".equals(tokenMap.get(token));
    }
    
    // 仅验证Token，不关心用户名（用于纯Token验证模式）
    public boolean validateToken(String token) {
        return tokenMap.containsValue(token);
    }
}