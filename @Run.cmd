mvn clean compile package
Stop-Process -Name "java" -Force
java -jar "./target/SpringBootRemotePowershellAdmin-2025.jar"
pause