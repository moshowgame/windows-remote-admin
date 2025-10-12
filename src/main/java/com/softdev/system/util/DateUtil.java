package com.softdev.system.util;

import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;

public class DateUtil {
    public static String formatTimestamp(long timestamp) {
        // 使用现代Java时间API替代SimpleDateFormat
        return Instant.ofEpochMilli(timestamp)
                .atZone(ZoneId.of("Asia/Shanghai"))
                .format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss"));
    }
}
