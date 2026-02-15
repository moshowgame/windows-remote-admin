package com.softdev.system;

import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@Slf4j
@SpringBootApplication
public class Application {
	public static void main(String[] args) {
		SpringApplication.run(Application.class,args);
		log.info("Windows Remote Admin - Portable Windows Management Tool");
		log.info("Designed for Windows systems without remote login support");
		log.info("Access at: http://localhost:12306/");
		log.info("GitHub: https://github.com/moshowgame/windows-remote-admin");
	}
}