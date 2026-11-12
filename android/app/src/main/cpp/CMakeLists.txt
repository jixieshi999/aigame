cmake_minimum_required(VERSION 3.18.1)

project("jimao-server")

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include_directories(
    ${CMAKE_CURRENT_SOURCE_DIR}/libnode/include/node
)

add_library(node SHARED IMPORTED)
set_target_properties(node PROPERTIES IMPORTED_LOCATION
    ${CMAKE_CURRENT_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libnode.so
)

add_library(native-lib SHARED
    native-lib.cpp
)

find_library(log-lib log)

target_link_libraries(native-lib
    node
    ${log-lib}
)
