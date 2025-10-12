package com.softdev.system.controller;

import cn.hutool.core.io.FileUtil;
import com.softdev.system.entity.FileInfo;
import com.softdev.system.entity.FileRequest;
import com.softdev.system.service.FileSystemService;
import com.softdev.system.util.ResponseUtil;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpSession;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.io.FileUtils;
import org.apache.commons.lang3.StringUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.ModelAndView;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

@Slf4j
@RestController
public class FileController {

    @Autowired
    FileSystemService fileSystemService;

    @GetMapping("/file")
    public ModelAndView file() {
        return new ModelAndView("file");
    }

    @PostMapping("/list")
    public Object listFile(@RequestBody FileRequest fileRequest, HttpServletRequest request) throws IOException {
        fileRequest.setExecutionType("list");
        fileRequest.setExecutionTime(new Date());

        //从session里面获取用户名和单据号，注入实体中
        HttpSession session = request.getSession(false);
        fileRequest.setUserName(session.getAttribute("entitledUser")+"");
        fileRequest.setTicketNumber(session.getAttribute("ticketNumber")+"");
        // 获取客户端IP地址
        fileRequest.setClientIpAddress(getClientIpAddress(request));

        // 确保路径合法化
        Path normalizedPath = Paths.get(fileRequest.getFilePath()).normalize();
        log.info("Audit Log - Listing files for path: {}", fileRequest);

        return ResponseUtil.success(fileSystemService.listFiles(normalizedPath.toString()));
    }

    @PostMapping("/listPlus")
    public Object listFilePlus(@RequestBody FileRequest fileRequest,HttpServletRequest request) throws IOException {
        fileRequest.setExecutionType("list");
        fileRequest.setExecutionTime(new Date());

        //从session里面获取用户名和单据号，注入实体中
        HttpSession session = request.getSession(false);
        fileRequest.setUserName(session.getAttribute("entitledUser")+"");
        fileRequest.setTicketNumber(session.getAttribute("ticketNumber")+"");
        // 获取客户端IP地址
        fileRequest.setClientIpAddress(getClientIpAddress(request));

        // 确保路径合法化
        Path normalizedPath = Paths.get(fileRequest.getFilePath()).normalize();
        log.info("Audit Log - Listing files for path: {} ", fileRequest);
        // 获取当前时间
        Instant now = Instant.now();
        Duration duration = Duration.ofDays(Long.parseLong(fileRequest.getDays()));
        // 获取所有文件
        List<FileInfo> allFiles = fileSystemService.listFiles(normalizedPath.toString());
        // 过滤时间不在查询范围
        List<FileInfo> filteredFiles = allFiles.stream()
                .filter(file -> {
                    Path filePath = Paths.get(fileRequest.getFilePath(), file.getName());
                    try {
                        BasicFileAttributes attr = Files.readAttributes(filePath, BasicFileAttributes.class);
                        Instant fileLastModifiedTime = attr.lastModifiedTime().toInstant();
                        return fileLastModifiedTime.isAfter(now.minus(duration));
                    } catch (IOException e) {
                        log.error("Error reading file attributes for path: {}", filePath, e);
                        return false;
                    }
                })
                .toList();

        if(StringUtils.isNotBlank(fileRequest.getFileNamePattern())){
            // 将通配符模式转换为正则表达式
            String fileNamePattern = fileRequest.getFileNamePattern().toLowerCase(Locale.ROOT).trim();

            // 过滤文件名称匹配fileNamePattern的文件
            filteredFiles = filteredFiles.stream()
                    .filter(file -> file.getName().toLowerCase(Locale.ROOT).contains(fileNamePattern))
                    .toList();
        }


        // 进一步过滤包含keyWord关键字的文件
        List<FileInfo> resultFiles = new ArrayList<>();
        if(StringUtils.isNotBlank(fileRequest.getKeyWord())){
            List<FileInfo> finalResultFiles = new ArrayList<>();
            filteredFiles = filteredFiles.stream()
                    .filter(file -> {
                        Path filePath = Paths.get(fileRequest.getFilePath(), file.getName());
                        try {
                            String fileContent= FileUtils.readFileToString(new File(filePath.toString()), StandardCharsets.UTF_8).replaceAll("\\u0000","").replaceAll("\u0000","").replaceAll("","");
//                            log.info("fileContent {}", fileContent);
                            if (fileContent.contains(fileRequest.getKeyWord().trim())) {
//                                log.info("File {} contains keyWord {}", filePath, fileRequest.getKeyWord());
                                finalResultFiles.add(file);
                            }
                        } catch (IOException e) {
                            e.printStackTrace();
                        }
                        return false;
                    })
                    .toList();
            resultFiles = finalResultFiles;
        }else {
            resultFiles = filteredFiles;
        }

        return ResponseUtil.success(resultFiles);
    }

    @PostMapping("/download")
    public ResponseEntity<Resource> downloadFile(@RequestBody FileRequest fileRequest,HttpServletRequest request) {
        fileRequest.setExecutionType("download");
        fileRequest.setExecutionTime(new Date());
        //从session里面获取用户名和单据号，注入实体中
        HttpSession session = request.getSession(false);
        fileRequest.setUserName(session.getAttribute("entitledUser")+"");
        fileRequest.setTicketNumber(session.getAttribute("ticketNumber")+"");
        // 获取客户端IP地址
        fileRequest.setClientIpAddress(getClientIpAddress(request));

        String filePath = fileRequest.getFilePath().replaceAll("//","");
        log.info("Audit Log - FileDownloadRequest:{} {}",filePath, fileRequest);
        Path path = Paths.get(filePath).normalize();

        // 安全校验
//        if (!path.startsWith("C:\\allowed_directory")) {
//            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
//        }

        Resource resource = new FileSystemResource(path);
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION,
                        "attachment; filename=\""+ System.currentTimeMillis() +"_"+ resource.getFilename() + "\"")
                .body(resource);
    }

    @PostMapping("/read")
    public Object read(@RequestBody FileRequest fileRequest,HttpServletRequest request) throws IOException {
        fileRequest.setExecutionType("read");
        fileRequest.setExecutionTime(new Date());
        //从session里面获取用户名和单据号，注入实体中
        HttpSession session = request.getSession(false);
        fileRequest.setUserName(session.getAttribute("entitledUser")+"");
        fileRequest.setTicketNumber(session.getAttribute("ticketNumber")+"");
        // 获取客户端IP地址
        fileRequest.setClientIpAddress(getClientIpAddress(request));

        Path path = Paths.get(fileRequest.getFilePath()).normalize();
        log.info("Audit Log - Read File Request:{} ",fileRequest);
        // 安全校验
//        if (!path.startsWith("C:\\allowed_directory")) {
//            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
//        }
        // 文件大小校验
        if (Files.size(path) > 10 * 1024 * 1024) {
            log.error("File exceeds 10MB limit :{} ", path );
            return ResponseUtil.fail(ResponseUtil.StatusCode.INTERNAL_ERROR,"File exceeds 10MB limit");
        }
        try {
            String contentType = Files.probeContentType(path);
            if(contentType == null && (
                fileRequest.getFilePath().toLowerCase().contains(".txt") ||
                fileRequest.getFilePath().toLowerCase().contains(".log") ||
                fileRequest.getFilePath().toLowerCase().contains(".json") ||
                fileRequest.getFilePath().toLowerCase().contains(".xml")
            )){
                //special file type
//                log.info("File is a near text file: {} {}", path , null);
            }
            else if (contentType == null){
//                log.error("File is a near text file: {} {}", path , null);
                return ResponseUtil.fail(ResponseUtil.StatusCode.INTERNAL_ERROR,"File is not a text file:"+null);
            }
            else if (!contentType.startsWith("text")) {
//                log.error("File is not a text file: {} {}", path , contentType);
                return ResponseUtil.fail(ResponseUtil.StatusCode.INTERNAL_ERROR,"File is not a text file:"+contentType);
            }
//            log.info("File type: {} {}", path , contentType);
        } catch (Exception e) {
//            log.error("Error checking file type for path: {}", path, e);
            return ResponseUtil.fail(ResponseUtil.StatusCode.INTERNAL_ERROR,"Error checking file type for path");
        }
        String fileContent = null;
        try {
            fileContent = FileUtil.readString(fileRequest.getFilePath(), StandardCharsets.UTF_8);
        } catch (Exception e) {
            fileContent = FileUtil.readString(fileRequest.getFilePath(), StandardCharsets.ISO_8859_1);
        }
        return fileContent;
    }
    
    /**
     * 获取客户端真实IP地址
     */
    private String getClientIpAddress(HttpServletRequest request) {
        String xip = request.getHeader("X-Real-IP");
        String xfor = request.getHeader("X-Forwarded-For");
        if (xfor != null && !xfor.isEmpty() && !"unknown".equalsIgnoreCase(xfor)) {
            //多次反向代理后会有多个ip值，第一个ip才是真实ip
            int index = xfor.indexOf(",");
            if (index != -1) {
                return xfor.substring(0, index);
            } else {
                return xfor;
            }
        }
        if (xip != null && !xip.isEmpty() && !"unknown".equalsIgnoreCase(xip)) {
            return xip;
        }
        String remoteAddr = request.getRemoteAddr();
        if (remoteAddr != null) {
            return remoteAddr;
        }
        return "unknown";
    }
}