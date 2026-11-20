cmake_minimum_required(VERSION 3.16)
set(PROJECT_VER "2.0.2")
include(FetchContent)
FetchContent_Declare(bosch_bme280
    GIT_REPOSITORY https://github.com/boschsensortec/BME280_SensorAPI.git
    GIT_TAG 3ba9abb813660f900365b56e15cac5b7848bb6c4
)
FetchContent_GetProperties(bosch_bme280)
if(NOT bosch_bme280_POPULATED)
    FetchContent_Populate(bosch_bme280)
endif()
# ESP-IDF also evaluates component CMake files in script mode. Fetch here,
# not in that pass, and use the deterministic build-local source path there.
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(balcony-weather)
