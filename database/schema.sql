CREATE DATABASE IF NOT EXISTS hospital_management
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;
USE hospital_management;

CREATE TABLE IF NOT EXISTS roles (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  role_name VARCHAR(80) NOT NULL UNIQUE,
  description VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS permissions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  permission_name VARCHAR(120) NOT NULL UNIQUE,
  module_name VARCHAR(80) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id BIGINT UNSIGNED NOT NULL,
  permission_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (role_id, permission_id),
  CONSTRAINT fk_role_permissions_role FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE RESTRICT,
  CONSTRAINT fk_role_permissions_permission FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  full_name VARCHAR(160) NOT NULL,
  email VARCHAR(254) NOT NULL UNIQUE,
  phone VARCHAR(32) NULL,
  department VARCHAR(100) NULL,
  password_hash VARCHAR(255) NOT NULL,
  role_id BIGINT UNSIGNED NOT NULL,
  status ENUM('Active', 'Inactive', 'Locked') NOT NULL DEFAULT 'Active',
  last_login TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE RESTRICT,
  INDEX idx_users_status_role (status, role_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  revoked_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_refresh_tokens_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
  INDEX idx_refresh_tokens_user_expiry (user_id, expires_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS module_records (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  module_key VARCHAR(40) NOT NULL,
  external_id VARCHAR(40) NOT NULL,
  data JSON NOT NULL,
  status VARCHAR(40) NULL,
  created_by BIGINT UNSIGNED NULL,
  updated_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP NULL,
  appointment_doctor VARCHAR(160) GENERATED ALWAYS AS (
    CASE WHEN module_key = 'appointments' AND deleted_at IS NULL
      AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(data, '$.status')), '') NOT IN ('Cancelled', 'Completed', 'No Show')
      THEN JSON_UNQUOTE(JSON_EXTRACT(data, '$.doctor')) ELSE NULL END
  ) STORED,
  appointment_date VARCHAR(10) GENERATED ALWAYS AS (
    CASE WHEN module_key = 'appointments' AND deleted_at IS NULL
      AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(data, '$.status')), '') NOT IN ('Cancelled', 'Completed', 'No Show')
      THEN JSON_UNQUOTE(JSON_EXTRACT(data, '$.date')) ELSE NULL END
  ) STORED,
  appointment_time VARCHAR(5) GENERATED ALWAYS AS (
    CASE WHEN module_key = 'appointments' AND deleted_at IS NULL
      AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(data, '$.status')), '') NOT IN ('Cancelled', 'Completed', 'No Show')
      THEN JSON_UNQUOTE(JSON_EXTRACT(data, '$.time')) ELSE NULL END
  ) STORED,
  room_number VARCHAR(40) GENERATED ALWAYS AS (
    CASE WHEN module_key = 'rooms' AND deleted_at IS NULL
      THEN JSON_UNQUOTE(JSON_EXTRACT(data, '$.room')) ELSE NULL END
  ) STORED,
  payment_reference VARCHAR(120) GENERATED ALWAYS AS (
    CASE WHEN module_key = 'payments' AND deleted_at IS NULL
      THEN NULLIF(JSON_UNQUOTE(JSON_EXTRACT(data, '$.transactionReference')), 'null') ELSE NULL END
  ) STORED,
  CONSTRAINT uq_module_record_id UNIQUE (module_key, external_id),
  CONSTRAINT fk_module_records_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_module_records_updated_by FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_module_status_created (module_key, status, created_at),
  INDEX idx_module_record_updated (module_key, updated_at),
  UNIQUE KEY uq_active_doctor_slot (appointment_doctor, appointment_date, appointment_time),
  UNIQUE KEY uq_active_room_number (room_number),
  UNIQUE KEY uq_payment_reference (payment_reference)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NULL,
  module_name VARCHAR(80) NOT NULL,
  action VARCHAR(80) NOT NULL,
  record_id VARCHAR(40) NULL,
  old_values JSON NULL,
  new_values JSON NULL,
  ip_address VARCHAR(45) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_audit_module_date (module_name, created_at),
  INDEX idx_audit_user_date (user_id, created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS patient_search_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  search_keyword VARCHAR(160) NOT NULL,
  search_type VARCHAR(40) NOT NULL DEFAULT 'all',
  searched_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_patient_search_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
  INDEX idx_patient_search_user_date (user_id, searched_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS system_settings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  setting_key VARCHAR(120) NOT NULL UNIQUE,
  setting_value JSON NOT NULL,
  updated_by BIGINT UNSIGNED NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_settings_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

INSERT IGNORE INTO roles (role_name, description) VALUES
  ('Super Admin', 'Full access to all hospital modules'),
  ('Admin', 'Manage hospital operations'),
  ('Doctor', 'Clinical access to assigned care modules'),
  ('Receptionist', 'Patient registration and appointments'),
  ('Nurse', 'Patient care and admission access'),
  ('Lab Technician', 'Laboratory orders and results'),
  ('Accountant', 'Billing, payments, and financial reports');

INSERT IGNORE INTO permissions (permission_name, module_name) VALUES
  ('patients:read', 'patients'), ('patients:create', 'patients'), ('patients:update', 'patients'), ('patients:delete', 'patients'),
  ('doctors:read', 'doctors'), ('doctors:create', 'doctors'), ('doctors:update', 'doctors'), ('doctors:delete', 'doctors'),
  ('departments:read', 'departments'), ('departments:create', 'departments'), ('departments:update', 'departments'), ('departments:delete', 'departments'),
  ('appointments:read', 'appointments'), ('appointments:create', 'appointments'), ('appointments:update', 'appointments'), ('appointments:delete', 'appointments'),
  ('rooms:read', 'rooms'), ('rooms:create', 'rooms'), ('rooms:update', 'rooms'), ('rooms:delete', 'rooms'),
  ('admissions:read', 'admissions'), ('admissions:create', 'admissions'), ('admissions:update', 'admissions'), ('admissions:delete', 'admissions'),
  ('medicalRecords:read', 'medicalRecords'), ('medicalRecords:create', 'medicalRecords'), ('medicalRecords:update', 'medicalRecords'),
  ('prescriptions:read', 'prescriptions'), ('prescriptions:create', 'prescriptions'), ('prescriptions:update', 'prescriptions'),
  ('laboratory:read', 'laboratory'), ('laboratory:create', 'laboratory'), ('laboratory:update', 'laboratory'), ('laboratory:delete', 'laboratory'),
  ('billing:read', 'billing'), ('billing:create', 'billing'), ('billing:update', 'billing'), ('billing:delete', 'billing'),
  ('payments:read', 'payments'), ('payments:create', 'payments'), ('reports:read', 'reports'), ('dashboard:read', 'dashboard'),
  ('staff:read', 'staff'), ('staff:create', 'staff'), ('staff:update', 'staff'), ('staff:delete', 'staff'),
  ('users:read', 'users'), ('users:create', 'users'), ('users:update', 'users'), ('users:delete', 'users'),
  ('settings:read', 'settings'), ('settings:update', 'settings'), ('auditLogs:read', 'auditLogs');
