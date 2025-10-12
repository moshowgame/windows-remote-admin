package com.softdev.system.entity;

import lombok.Data;

import java.util.Date;

@Data
public class ShellRequest {
    String command;
    String userName;
    String executionType;
    String ticketNumber;
    Date executionTime;
    String encoding;
    String clientIpAddress;
}