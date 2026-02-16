package com.softdev.system.entity;

import lombok.Data;

import java.util.Date;

@Data
public class FileRequest {
    String filePath;
    String userName;
    String executionType;
    Date executionTime;
    String fileNamePattern;
    String keyWord;
    String purpose;
    String days;
    String clientIpAddress;
}