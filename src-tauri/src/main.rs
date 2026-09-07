#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    postgres_ui_lib::run();
}
