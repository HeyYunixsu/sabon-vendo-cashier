#include <FL/Fl.H>
#include <FL/Fl_Double_Window.H>
#include <FL/Fl_Group.H> // For custom components
#include <FL/Fl_Box.H>
#include <FL/Fl_Button.H>
#include <FL/fl_message.H>
#include <FL/fl_draw.H> // For drawing utilities, though not strictly needed for just colors/boxes
#include <FL/Fl_Image.H> // Base image class
#include <FL/Fl_PNG_Image.H> // For PNG images, or <FL/Fl_JPEG_Image.H> for JPEGs etc.

#include <iostream>      // For debug output
#include <filesystem>    // For path manipulation
#include <memory>        // For std::unique_ptr (though we're using raw pointers here for consistency with your sample)
#include <cmath>
#include <map>
#include <fstream>

#include <iomanip> // For std::setw, std::setfill
#include <sstream> // For std::stringstream

#include <string>
#include <cstring> // For memset
#include <thread>  // For std::this_thread::sleep_for
#include <chrono>  // For std::chrono::milliseconds

// Platform-specific headers for sockets
#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h> // For InetPton
#pragma comment(lib, "ws2_32.lib")
typedef SOCKET SocketHandle;
#define CLOSESOCKET(s) closesocket(s)
#define GET_LAST_SOCKET_ERROR() WSAGetLastError()
#define SOCKET_ERROR_WOULDBLOCK WSAEWOULDBLOCK
#else
#include <sys/socket.h>
#include <arpa/inet.h> // For inet_pton
#include <unistd.h>    // For close
#include <fcntl.h>     // For fcntl (non-blocking)
#include <errno.h>     // For errno
typedef int SocketHandle;
#define CLOSESOCKET(s) close(s)
#define GET_LAST_SOCKET_ERROR() errno
#define SOCKET_ERROR_WOULDBLOCK EAGAIN // Or EWOULDBLOCK
#endif



// Make sure to define your image path correctly.
// For demonstration, let's assume 'Logo.png' is in a 'Resources' subfolder
// relative to your executable.
#ifndef IMAGE_PATH_ROOT
// This will be set by CMake or build script in a real project
// For a quick test, you might hardcode or derive relative to cwd
#define IMAGE_PATH_ROOT "./Resources/"
#endif

void client_app_setup();
void client_app_loop(void* data);
void set_socket_non_blocking(SocketHandle sock);
void update_gui_display(const std::string& data);
bool initialize_socket_environment();
bool establish_server_connection();
void receive_data_from_server(void* data);
void send_periodic_acknowledgement();
void cleanup_socket_environment();
std::string convertMillisecondsToMMMSS(long long total_seconds);
std::string trim(const std::string &s);
std::map<std::string, std::string> loadEnv(const std::string &filepath);

// Function to convert total seconds to MMM:SS format
std::string convertMillisecondsToMMMSS(long long total_milliseconds) {
    if (total_milliseconds < 0) {
        return "Invalid Input"; // Handle negative milliseconds
    }

    // Convert total milliseconds to total seconds first
    long long total_seconds = total_milliseconds / 1000;

    long long total_minutes = total_seconds / 60;        // Total minutes (including those from hours)
    long long remaining_seconds = total_seconds % 60; // Seconds remaining after extracting full minutes

    // Use std::stringstream for formatting with leading zeros
    std::stringstream ss;

    // For minutes, we still use setw(3) for "065" style, but it can expand if needed.
    ss << std::setw(3) << std::setfill('0') << total_minutes << ":"
       << std::setw(2) << std::setfill('0') << remaining_seconds;

    return ss.str();
}


// --- Global/Static Variables for Client State ---
SocketHandle g_client_socket = (SocketHandle)-1;
std::chrono::steady_clock::time_point g_last_acknowledgement_send_time;



// --- Constants ---
const int SERVER_PORT = 8080;
const char* SERVER_IP = "127.0.0.1"; // Loopback address for local testing
const int MAX_BUFFER_SIZE = 1024;
const std::chrono::seconds ACK_SEND_INTERVAL(5); // Send an ACK every 5 seconds
const std::chrono::milliseconds LOOP_SLEEP_MS(50); // Sleep duration in main loop

// std::map<std::string, std::string> config;

// std::string slotName1 = "";
// std::string slotColor1 = "";

// std::string slotName2 = "";
// std::string slotColor2 = "";

// std::string slotName3 = "";
// std::string slotColor3 = "";

// std::string slotName4 = "";
// std::string slotColor4 = "";

Fl_Color parse_config_color(std::string config_val) {
    int r, g, b;
    // This parses the format "(r, g, b)"
    if (sscanf(config_val.c_str(), "(%d, %d, %d)", &r, &g, &b) == 3) {
        return fl_rgb_color((unsigned char)r, (unsigned char)g, (unsigned char)b);
    }
    return FL_GRAY; // Fallback color
}

// --- Helper Function: Set Socket to Non-Blocking ---
void set_socket_non_blocking(SocketHandle sock) {
#ifdef _WIN32
    u_long mode = 1; // 1 to enable non-blocking, 0 to disable
    if (ioctlsocket(sock, FIONBIO, &mode) != 0) {
        std::cerr << "Error setting non-blocking (ioctlsocket): " << GET_LAST_SOCKET_ERROR() << std::endl;
    }
#else
    int flags = fcntl(sock, F_GETFL, 0);
    if (flags == -1) {
        perror("Error getting socket flags (fcntl F_GETFL)");
        return;
    }
    if (fcntl(sock, F_SETFL, flags | O_NONBLOCK) == -1) {
        perror("Error setting non-blocking (fcntl F_SETFL O_NONBLOCK)");
    }
#endif
}

// --- Conceptual GUI Display Function ---
// In a real FLTK/C++ GUI application, this would update your UI elements.
void update_gui_display(const std::string& data) {
    // This is where your FLTK/GUI logic would go.
    // For this example, we'll just print to console.
    std::cout << "[GUI Update] Displaying: " << data << std::endl;
    // Example for FLTK (assuming you have an Fl_Text_Display widget named 'text_display'):
    // if (Fl::awake()) { // Check if Fl::run() has been called
    //     text_display->buffer()->append(data.c_str());
    //     text_display->buffer()->append("\n");
    //     Fl::flush(); // Update the display
    // }
}

void unescape_newline(std::string &s) {
    size_t pos = 0;
    // Look for the literal two-character sequence "\" and "n"
    while ((pos = s.find("\\n", pos)) != std::string::npos) {
        s.replace(pos, 2, "\n");
        pos += 1; // Move past the newly inserted newline character
    }
}

// --- 1. Define your custom components (Header, SideBar, MainContent, Footer) ---
// Component: Dashboard
class Dashboard : public Fl_Group {
public:
    int currentCoins;
    int _pause_state;

    std::string value1;
    std::string value2;
    std::string value3;
    std::string value4; 

    std::string wtrLvl1;
    std::string wtrLvl2;
    std::string wtrLvl3;
    std::string wtrLvl4; 
    
    // Constructor takes position (x, y), dimensions (w, h) from its parent
    Dashboard(int x, int y, int w, int h) : Fl_Group(x, y, w, h, "") {
        box(FL_THIN_DOWN_BOX); // Give the dashboard a subtle border
        color(FL_LIGHT2);      // A neutral background for the dashboard itself

        // --- Calculate panel heights based on parent's height (h) ---
        int upper_panel_height = (h * 2 )/ 5;
        int lower_panel_height = (h * 3) / 5; // Note: This sum is 3/5, leaving 2/5 if needed for padding/other elements

        std::map<std::string, std::string> config = loadEnv("../CONFIG/config.env");

        std::string slotName1 = config.count("slotName1") ? config["slotName1"] : "Slot 1";
        std::string slotName2 = config.count("slotName2") ? config["slotName2"] : "Slot 2";
        std::string slotName3 = config.count("slotName3") ? config["slotName3"] : "Slot 3";
        std::string slotName4 = config.count("slotName4") ? config["slotName4"] : "Slot 4";
        
        std::string slotColor1 = config.count("slotColor1") ? config["slotColor1"] : "";
        std::string slotColor2 = config.count("slotColor2") ? config["slotColor2"] : "";
        std::string slotColor3 = config.count("slotColor3") ? config["slotColor3"] : "";
        std::string slotColor4 = config.count("slotColor4") ? config["slotColor4"] : "";

        unescape_newline(slotName1);
        unescape_newline(slotName2);
        unescape_newline(slotName3);
        unescape_newline(slotName4);

        // --- 1. Upper Panel (1/5 of parent height) ---
        upper_panel = new Fl_Group(x, y, w, upper_panel_height);
        upper_panel->box(FL_EMBOSSED_FRAME); // Frame for visual separation
        upper_panel->color(FL_FOREGROUND_COLOR); // A lighter color
        upper_panel->end(); // End the upper_panel group for widget creation
        
        // Inside Upper Panel: Two Labels for "Total Credit:" key/value
        // Position relative to upper_panel's x, y
        total_credit_label = new Fl_Box(upper_panel->x() + 10, upper_panel->y() + upper_panel_height / 4, ((w * 2) / 5) - 10, (upper_panel_height / 2), "Total Credit:");
        // total_credit_label->box(FL_UP_BOX); 
        total_credit_label->align(FL_ALIGN_LEFT | FL_ALIGN_INSIDE);
        total_credit_label->labelsize(80);
        // This value can be updated dynamically later
        total_credit_value = new Fl_Box(total_credit_label->x() + total_credit_label->w() + 5, upper_panel->y() + upper_panel_height / 4, ((w * 1) / 5) - 5, (upper_panel_height / 2), "0.00");
        // total_credit_value->box(FL_UP_BOX); 
        total_credit_value->align(FL_ALIGN_CENTER);
        total_credit_value->labelfont(FL_BOLD);
        total_credit_value->labelsize(80);
        // This value can be updated dynamically later
        pause_status_value = new Fl_Box(total_credit_value->x() + total_credit_value->w() + 5, upper_panel->y() + upper_panel_height / 4, ((w * 2) / 5) - 5, (upper_panel_height / 2), "");
        // pause_status_value->box(FL_UP_BOX); 
        pause_status_value->align(FL_ALIGN_RIGHT | FL_ALIGN_INSIDE);
        pause_status_value->labelfont(FL_BOLD);
        pause_status_value->labelsize(80);


        // --- 2. Lower Panel (2/5 of parent height) ---
        lower_panel = new Fl_Group(x, y + upper_panel_height, w, lower_panel_height);
        lower_panel->box(FL_ENGRAVED_FRAME); // Another frame style
        lower_panel->color(FL_BACKGROUND_COLOR); // Default FLTK background
        lower_panel->end(); // End the lower_panel group

        // Inside Lower Panel: 4 Sub-Panels in a 2x2 grid
        // Calculate dimensions for sub-panels relative to lower_panel's size
        int sub_panel_width = lower_panel->w() / 2;
        int sub_panel_height = lower_panel->h() / 2;
        int sub_panel_padding = 5; // Small padding between sub-panels

        // Sub-Panel 1 (Top-Left)
        sub_panel1 = new Fl_Group(lower_panel->x() + sub_panel_padding,
                                  lower_panel->y() + sub_panel_padding,
                                  sub_panel_width - sub_panel_padding * 2,
                                  sub_panel_height - sub_panel_padding * 2);
        sub_panel1->box(FL_BORDER_BOX);
        sub_panel1->color(parse_config_color(slotColor1));
        sub_panel1->end();
        timer1_label = new Fl_Box(sub_panel1->x(), sub_panel1->y() + 10, sub_panel1->w() / 2, sub_panel1->h(), 0);
        timer1_label->copy_label(slotName1.c_str());
        
        timer1_value = new Fl_Box(sub_panel1->x() + (sub_panel1->w() / 2), sub_panel1->y() + 10, sub_panel1->w() / 2, sub_panel1->h(), "");
        timer1_value->labelfont(FL_BOLD);
        timer1_value->labelcolor(FL_BLACK);
    	timer1_label->align(FL_ALIGN_INSIDE); //FL_ALIGN_LEFT);
        timer1_value->align(FL_ALIGN_LEFT);
        timer1_label->labelsize(60);
        timer1_value->labelsize(70);

        // Sub-Panel 2 (Top-Right)
        sub_panel2 = new Fl_Group(lower_panel->x() + sub_panel_width + sub_panel_padding,
                                  lower_panel->y() + sub_panel_padding,
                                  sub_panel_width - sub_panel_padding * 2,
                                  sub_panel_height - sub_panel_padding * 2);
        sub_panel2->box(FL_BORDER_BOX);
        sub_panel2->color(parse_config_color(slotColor2));
        sub_panel2->end();
        timer2_label = new Fl_Box(sub_panel2->x(), sub_panel2->y() + 10, sub_panel2->w() / 2, sub_panel2->h(), 0);
        timer2_label->copy_label(slotName2.c_str());
        timer2_value = new Fl_Box(sub_panel2->x() + (sub_panel2->w() / 2), sub_panel2->y() + 10, sub_panel2->w() / 2, sub_panel2->h(), "");
        timer2_value->labelfont(FL_BOLD);
        timer2_label->align(FL_ALIGN_INSIDE);
        timer2_value->align(FL_ALIGN_LEFT);
        timer2_label->labelsize(60);
        timer2_value->labelsize(70);

        // Sub-Panel 3 (Bottom-Left)
        sub_panel3 = new Fl_Group(lower_panel->x() + sub_panel_padding,
                                  lower_panel->y() + sub_panel_height + sub_panel_padding,
                                  sub_panel_width - sub_panel_padding * 2,
                                  sub_panel_height - sub_panel_padding * 2);
        sub_panel3->box(FL_BORDER_BOX);
        sub_panel3->color(parse_config_color(slotColor3));
        sub_panel3->end();
        timer3_label = new Fl_Box(sub_panel3->x(), sub_panel3->y() + 10, sub_panel3->w() / 2, sub_panel3->h(), 0);
        timer3_label->copy_label(slotName3.c_str());
        timer3_value = new Fl_Box(sub_panel3->x() + (sub_panel3->w() / 2), sub_panel3->y() + 10, sub_panel3->w() / 2, sub_panel3->h(), "");
        timer3_value->labelfont(FL_BOLD);
        timer3_label->align(FL_ALIGN_INSIDE);
        timer3_value->align(FL_ALIGN_LEFT);
        timer3_label->labelsize(60);
        timer3_value->labelsize(70);

        // Sub-Panel 4 (Bottom-Right)
        sub_panel4 = new Fl_Group(lower_panel->x() + sub_panel_width + sub_panel_padding,
                                  lower_panel->y() + sub_panel_height + sub_panel_padding,
                                  sub_panel_width - sub_panel_padding * 2,
                                  sub_panel_height - sub_panel_padding * 2);
        sub_panel4->box(FL_BORDER_BOX);
        sub_panel4->color(parse_config_color(slotColor4));
        sub_panel4->end();
        timer4_label = new Fl_Box(sub_panel4->x(), sub_panel4->y() + 10, sub_panel4->w() / 2, sub_panel4->h(), 0);
        timer4_label->copy_label(slotName4.c_str());
        timer4_value = new Fl_Box(sub_panel4->x() + (sub_panel4->w() / 2), sub_panel4->y() + 10, sub_panel4->w() / 2, sub_panel4->h(), "");
        timer4_value->labelfont(FL_BOLD);
        timer4_label->align(FL_ALIGN_INSIDE);
        timer4_value->align(FL_ALIGN_LEFT);
        timer4_label->labelsize(60);
        timer4_value->labelsize(70);

        Fl::add_timeout(1.0, static_blink_cb, this);
        
        // Ensure all widgets are children of this Dashboard group
        end();
    }
    
    // Destructor to clean up dynamically allocated widgets
    ~Dashboard() {
        delete total_credit_label;
        delete total_credit_value;
        delete timer1_label;
        delete timer1_value;
        delete timer2_label;
        delete timer2_value;
        delete timer3_label;
        delete timer3_value;
        delete timer4_label;
        delete timer4_value;
        delete sub_panel1;
        delete sub_panel2;
        delete sub_panel3;
        delete sub_panel4;
        delete upper_panel;
        delete lower_panel;
    }

    void blink_callback(void* data){
        if (_pause_state == 1)
        {
            Fl_Color current_color = pause_status_value->labelcolor();
            
            // Toggle the color
            if (current_color == FL_RED) {
                pause_status_value->labelcolor(FL_BLACK);
            } else {
                pause_status_value->labelcolor(FL_RED);
            }
    
            // Force the widget to redraw itself immediately
            pause_status_value->redraw();
        }
        // Schedule this function to run again in 1 second (1.0)
        // Fl::add_timeout(1.0, static_blink_cb, this);
    }

    static void static_blink_cb(void* data){
        Dashboard* self = static_cast<Dashboard*>(data);
        
        // 2. Call the non-static member function (your logic)
        self->blink_callback(data);
        
        // 3. Reschedule the static function for a repeating timer (1.0 second interval)
        // IMPORTANT: You MUST pass the original 'data' (the 'this' pointer) back!
        Fl::add_timeout(0.5, static_blink_cb, data);
    }

    void updateCoins(int newCoins) {
        if (currentCoins == newCoins)
            return;

        currentCoins = newCoins;
        // Format the new string for the label
        // std::snprintf is safer than sprintf
        // char buffer[10]; // Make sure buffer is large enough for your text + number
        // snprintf(buffer, sizeof(buffer), "%d", currentCoins);

        // Set the new label for the Fl_Box
        // total_credit_value->label(buffer);
        std::cout << "inside Dashboard: " << currentCoins << std::endl;

        // 1. Convert the integer to a std::string and store it in the member variable.
        coins_display_str = std::to_string(currentCoins);

        // 2. Set the new label using the C-string from the persistent member variable.
        total_credit_value->label(coins_display_str.c_str());
        total_credit_value->align(FL_ALIGN_LEFT | FL_ALIGN_INSIDE);
        total_credit_value->labelfont(FL_BOLD);
        total_credit_value->labelsize(80);
        
        // 3. Tell FLTK to redraw the widget to show the new text.
        total_credit_value->redraw();
        // Optionally, if the Dashboard itself is in a complex layout,
        // you might need to redraw its parent or the entire window.
        // this->redraw(); // Redraws the entire Dashboard window
    }

    void updatePauseState(int pause_state){
        if (_pause_state == pause_state)
            return;
        _pause_state = pause_state;
        std::cout << "inside Dashboard (pause_state): " << pause_state << std::endl;
        
        // 1. Convert the integer to a std::string and store it in the member variable.
        pause_state_str = "";
        if (_pause_state == 1)
            pause_state_str = "PAUSED";

        // 2. Set the new label using the C-string from the persistent member variable.
        pause_status_value->label(pause_state_str.c_str());
        pause_status_value->align(FL_ALIGN_LEFT | FL_ALIGN_INSIDE);
        pause_status_value->labelfont(FL_BOLD);
        pause_status_value->labelsize(80);
        
        // 3. Tell FLTK to redraw the widget to show the new text.
        pause_status_value->redraw();
    }

    void updateWaterLevel(int slotId, std::string& valueString) {
        std::cout << "WTRLVL: " << slotId << " value: " << valueString  << std::endl;
        std::cout << "Current WTR BUffer: " << wtrLvl1 << " | " << wtrLvl2 << " | " << wtrLvl3 << " | " << wtrLvl4 << " | " << std::endl;
        
        switch(slotId){
            case 1:
                {
                    Fl_Color current_color = timer1_value->labelcolor();
                    Fl_Color select_color = (wtrLvl1 == "1") ? FL_RED : FL_BLACK;

                    if (wtrLvl1 == valueString & current_color == select_color)
                        break;
                    wtrLvl1 = valueString;

                    timer1_value->labelcolor(select_color);
                    timer1_value->redraw();
                }
                break;
            case 2:
                {
                    Fl_Color current_color = timer2_value->labelcolor();
                    Fl_Color select_color = (wtrLvl2 == "1") ? FL_RED : FL_BLACK;

                    if (wtrLvl2 == valueString & current_color == select_color)
                        break;
                    wtrLvl2 = valueString;

                    timer2_value->labelcolor(select_color);
                    timer2_value->redraw();
                }
                break;
            case 3:
                {
                    Fl_Color current_color = timer3_value->labelcolor();
                    Fl_Color select_color = (wtrLvl3 == "1") ? FL_RED : FL_BLACK;

                    if (wtrLvl3 == valueString & current_color == select_color)
                        break;
                    wtrLvl3 = valueString;
                    timer3_value->labelcolor(select_color);
                    timer3_value->redraw();
                }
                break;
            case 4:
                {
                    Fl_Color current_color = timer4_value->labelcolor();
                    Fl_Color select_color = (wtrLvl4 == "1") ? FL_RED : FL_BLACK;

                    if (wtrLvl4 == valueString & current_color == select_color)
                        break;
                    wtrLvl4 = valueString;
                    timer4_value->labelcolor(select_color);
                    timer4_value->redraw();
                }
                break;
            default:
                break;
        }
    }

    void updateTimer(int slotId, std::string& valueString) {
        std::cout << "Slot: " << slotId << " value: " << valueString;

        switch(slotId){
            case 1:
                {
                    Fl_Color current_color = timer1_value->labelcolor();
                    Fl_Color select_color = (wtrLvl1 == "1") ? FL_RED : FL_BLACK;

                    if (value1 == valueString && current_color == select_color)
                        break;
                    value1 = valueString;

                    timer1_value->copy_label(value1.c_str());
                    timer1_value->labelcolor(select_color);
                    timer1_value->align(FL_ALIGN_LEFT | FL_ALIGN_INSIDE);
                    timer1_value->labelfont(FL_BOLD);
                    timer1_value->labelsize(70);
                    timer1_value->redraw();
                }
                break;
            case 2:
                {
                    Fl_Color current_color = timer2_value->labelcolor();
                    Fl_Color select_color = (wtrLvl2 == "1") ? FL_RED : FL_BLACK;

                    if (value2 == valueString && current_color == select_color)
                        break;
                    value2 = valueString;
                    timer2_value->copy_label(value2.c_str());
                    timer2_value->labelcolor(select_color);
                    timer2_value->align(FL_ALIGN_LEFT | FL_ALIGN_INSIDE);
                    timer2_value->labelfont(FL_BOLD);
                    timer2_value->labelsize(70);
                    timer2_value->redraw();
                }
                break;
            case 3:
                {
                    Fl_Color current_color = timer3_value->labelcolor();
                    Fl_Color select_color = (wtrLvl3 == "1") ? FL_RED : FL_BLACK;

                    if (value3 == valueString && current_color == select_color)
                        break;
                    value3 = valueString;
                    timer3_value->copy_label(value3.c_str());
                    timer3_value->labelcolor(select_color);
                    timer3_value->align(FL_ALIGN_LEFT | FL_ALIGN_INSIDE);
                    timer3_value->labelfont(FL_BOLD);
                    timer3_value->labelsize(70);
                    timer3_value->redraw();
                }
                break;
            case 4:
                {
                    Fl_Color current_color = timer4_value->labelcolor();
                    Fl_Color select_color = (wtrLvl4 == "1") ? FL_RED : FL_BLACK;

                    if (value4 == valueString && current_color == select_color)
                        break;
                    value4 = valueString;
                    timer4_value->copy_label(value4.c_str());
                    timer4_value->labelcolor(select_color);
                    timer4_value->align(FL_ALIGN_LEFT | FL_ALIGN_INSIDE);
                    timer4_value->labelfont(FL_BOLD);
                    timer4_value->labelsize(70);
                    timer4_value->redraw();
                }
                break;
            default:
                break;
        }
    }


private:
    std::string coins_display_str;    
    std::string pause_state_str;    
    
    Fl_Group* upper_panel;
    Fl_Group* lower_panel;

    Fl_Box* total_credit_label;
    Fl_Box* total_credit_value;
    Fl_Box* pause_status_value;

    Fl_Group* sub_panel1;
    Fl_Group* sub_panel2;
    Fl_Group* sub_panel3;
    Fl_Group* sub_panel4;

    Fl_Box* timer1_label;
    Fl_Box* timer1_value;
    Fl_Box* timer2_label;
    Fl_Box* timer2_value;
    Fl_Box* timer3_label;
    Fl_Box* timer3_value;
    Fl_Box* timer4_label;
    Fl_Box* timer4_value;
};

// Helper function to resolve resource paths.
// In a real application, you might have a global utility for this.
std::string get_resource_path(int argc, char** argv, const std::string& filename) {
    std::filesystem::path exe_path = argv[0];
    std::filesystem::path dir_path = exe_path.parent_path();

    // Adjust path for macOS app bundles if necessary, similar to your previous example.
    // This assumes your Logo.png is in 'Contents/Resources' within the .app bundle
    // or directly in a 'Resources' folder next to the executable on other OS.
#ifdef __APPLE__
    // On macOS, resources are typically in ../Resources relative to the executable
    // within the .app bundle structure (e.g., MyApp.app/Contents/MacOS/my_app_executable)
    std::filesystem::path logo_path = dir_path / ".." / "Resources" / filename;
#else
    // On other OS, assume Resources is a sibling directory to the executable
    std::filesystem::path logo_path = dir_path / "Resources" / filename;
#endif

    // Fallback if the above path doesn't exist, e.g., for direct run from build dir
    if (!std::filesystem::exists(logo_path)) {
        logo_path = std::filesystem::path(IMAGE_PATH_ROOT) / filename;
    }
    if (!std::filesystem::exists(logo_path)) {
        std::cerr << "Warning: Could not find resource file: " << logo_path.string() << std::endl;
        std::cerr << "Attempting from current working directory: " << std::filesystem::current_path().string() << std::endl;
        logo_path = std::filesystem::current_path() / "Resources" / filename; // Last resort
    }

    return logo_path.string();
}


// Component: Header
class Header : public Fl_Group {
public:
    // Constructor takes position (x, y), dimensions (w, h), and an optional label
    Header(int x, int y, int w, int h, int argc, char** argv) : Fl_Group(x, y, w, h, "") {
        // Set background color to FL_CYAN
        color(FL_DARK_BLUE);
        box(FL_FLAT_BOX); // Make the background visible
        
        // Define a consistent height for the header elements
        int element_height = 120; // Hamburger, Logo

        // 1. Logo Box
        int logo_size = element_height; // Square logo, same height as button
        int logo_padding_x = 10;
        int logo_padding_y = 10;
        int center_y = std::floor(h / 2);
        int logo_size_w = static_cast<int> (std::floor(logo_size * 1.2));
        // Create the logo box
        logo_box = new Fl_Box(x + logo_padding_x, y + logo_padding_y, logo_size_w, logo_size);
        logo_box->box(FL_NO_BOX); // No visible box around the logo

        // Load the image (using the helper function for robust path resolution)
        std::string logo_path_str = get_resource_path(argc, argv, "sabon_express.png");
        logo_image = new Fl_PNG_Image(logo_path_str.c_str());

        if (logo_image->fail()) {
            std::cerr << "Error: Could not load logo image from " << logo_path_str << std::endl;
            delete logo_image; // Clean up failed image
            logo_image = nullptr; // Mark as not loaded
        } else {
            // Scale the image to fit the logo_box if it's too big, or just set it
            // For simple scaling, you might create a scaled version:
            Fl_Image* scaled_logo = logo_image->copy(logo_size_w, logo_size);
            logo_box->image(scaled_logo);
            // Note: scaled_logo now owns the scaled data.
            // You might want to keep original_logo_image if you need it unscaled elsewhere.
            // For simplicity here, we'll assign scaled_logo and manage its lifetime.
            // The original logo_image can be kept or deleted depending on need.
            delete logo_image; // Delete the original, now using the scaled one
            logo_image = scaled_logo; // Assign the scaled image to the member pointer
        }

        
        //  // 2. Hamburger Button
        // // Position it to the right of the logo, with some spacing
        // int hamburger_x = logo_box->x() + logo_box->w() + 10;
        // hamburger_button = new Fl_Button(hamburger_x, y + logo_padding_y, element_height, element_height, "☰");
        // hamburger_button->box(FL_NO_BOX); // No visible box around the logo
        // hamburger_button->labelsize(20);
        // hamburger_button->labelfont(FL_BOLD);

        // 3. Company Name (Title Box)
        // Position it to the right of the hamburger button, with some spacing
        // int title_x = hamburger_button->x() + hamburger_button->w() + 20;
        int title_x = logo_box->x() + logo_box->w() + 20;
        int title_width = w - title_x - 50; // Remaining width for the title
        title_box = new Fl_Box(title_x, y + center_y - 50, title_width, element_height, "SABON EXPRESS");
        title_box->labelfont(FL_BOLD);
        title_box->labelsize(90);
        title_box->labelcolor(FL_WHITE);
        title_box->align(FL_ALIGN_LEFT | FL_ALIGN_INSIDE); // Align text to the left

        end(); // End of Fl_Group construction

    }

    // Destructor to clean up dynamically allocated image and box if using pointers
    ~Header() {
        // FLTK widgets added to a group are usually deleted by the group
        // when the group is deleted. However, if you explicitly new'd them
        // and they are not children of another widget that owns them,
        // or if you want to ensure cleanup of images, explicit deletion is good.
        // In this specific case, since they are direct children of the Header group,
        // FLTK will manage them on group deletion.
        // However, the Fl_Image object *is* explicitly new'd and needs manual deletion.

        // It's crucial to delete the Fl_Image object.
        // If the logo_box's image pointer is set to a *copy* of the original image,
        // ensure you delete the *copied* image that the box is using.
        if (logo_image) {
            // This is the image object currently set to logo_box
            delete logo_image;
            logo_image = nullptr;
        }

        // The widgets (buttons, boxes) added to 'this' group are typically
        // deleted when the group itself is deleted by FLTK.
        // Explicitly deleting them here can sometimes lead to double-free
        // if FLTK also tries to delete them.
        // For Fl_Group and its direct children, it's safer to let FLTK handle it,
        // UNLESS you are removing children dynamically.
        // For the sake of clear ownership from the original problem,
        // and if these were NOT direct children of the group, then explicit deletes are needed.
        // For direct children of a group, FLTK handles their deletion usually.
        // However, if Fl_Box* logo_box; is NOT a child of this group, then delete logo_box;
        // In this case, they ARE children.
    }
    
    Fl_Button* get_hamburger_button() {
        return hamburger_button;
    }

private:
    Fl_Button* hamburger_button;
    Fl_Box* title_box;
    Fl_Box* logo_box;
    Fl_Image* logo_image; // This will hold the (possibly scaled) image used by logo_box
};

// Component: SideBar
class SideBar : public Fl_Group {
public:
    SideBar(int x, int y, int w, int h) : Fl_Group(x, y, w, h, "") {
        original_width_ = w; // Store initial width
        current_width_ = w;
        is_hidden_ = false;  // Initially visible

        color(FL_WHITE);
        box(FL_FLAT_BOX);

        // Add navigation buttons
        button1 = new Fl_Button(x + 10, y + 10, w - 20, 30, "");
        button1->callback([](Fl_Widget* w, void* data){ fl_message("Dashboard clicked!"); });

        button2 = new Fl_Button(x + 10, y + 50, w - 20, 30, "Settings");
        button2->callback([](Fl_Widget* w, void* data){ fl_message("Settings clicked!"); });
        end();
    }

    // New methods to toggle visibility
    void show_sidebar() {
        if (is_hidden_) {
            current_width_ = original_width_;
            this->show(); // Make the widget visible
            is_hidden_ = false;
        }
    }

    void hide_sidebar() {
        if (!is_hidden_) {
            current_width_ = 0; // Set width to 0 when hidden (effectively collapsed)
            this->hide(); // Hide the widget
            is_hidden_ = true;
        }
    }

    bool is_visible() const {
        return !is_hidden_;
    }

    int get_current_width() const {
        return current_width_;
    }

    int get_original_width() const {
        return original_width_;
    }

private:
    int original_width_;
    int current_width_; // Tracks actual width used in layout (original or 0)
    bool is_hidden_;    

    Fl_Button* button1;
    Fl_Button* button2;
};

// Component: MainContent
class MainContent : public Fl_Group {
public:
    MainContent(int x, int y, int w, int h) : Fl_Group(x, y, w, h, "") {
        color(FL_BACKGROUND_COLOR); // Default FLTK background
        box(FL_DOWN_BOX);

        // content_label = new Fl_Box(x + 20, y + 20, w - 40, 50, "Welcome to the Main Area!");
        // content_label->labelsize(20);
        // content_label->labelfont(FL_ITALIC);
        dashboard_view = new Dashboard(x, y, w, h); // Pass MainContent's x,y,w,h to Dashboard

        end();
    }
    ~MainContent(){
        delete content_label;
        delete dashboard_view;
    }

    void updateCoin(int newCoins){
        if (dashboard_view){
            dashboard_view->updateCoins(newCoins);
        }
    }

    void updatePauseState(int pause_state){
        if (dashboard_view){
            dashboard_view->updatePauseState(pause_state);
        }
    }

    void updateWaterLevel(std::string wtr1, std::string wtr2, std::string wtr3, std::string wtr4){
        if (dashboard_view){
            dashboard_view->updateWaterLevel(1, wtr1);
            dashboard_view->updateWaterLevel(2, wtr2);
            dashboard_view->updateWaterLevel(3, wtr3);
            dashboard_view->updateWaterLevel(4, wtr4);
        }
    }


    void updateTimer(std::string timer1, std::string timer2, std::string timer3, std::string timer4){
        if (dashboard_view){
            dashboard_view->updateTimer(1, timer1);
            dashboard_view->updateTimer(2, timer2);
            dashboard_view->updateTimer(3, timer3);
            dashboard_view->updateTimer(4, timer4);
        }
    }
    
private:
    Fl_Box* content_label;
    Dashboard* dashboard_view;
};

// Component: Footer
class Footer : public Fl_Group {
public:
    Footer(int x, int y, int w, int h) : Fl_Group(x, y, w, h, "") {
        // color(FL_DARK_CYAN);
        color(FL_WHITE);
        box(FL_FLAT_BOX);

        // status_label = new Fl_Box(x + 10, y + 5, w - 20, 20, "Status: Ready");
        // status_label->labelcolor(FL_WHITE);
        // status_label->align(FL_ALIGN_LEFT | FL_ALIGN_INSIDE);
        end();
    }
private:
    Fl_Box* status_label;
};


// --- 2. Compose the MainWindow using these components ---

class MainWindow : public Fl_Double_Window {
public:
    MainWindow(int argc, char** argv) : Fl_Double_Window(0, 0, 800, 600, "Modular FLTK App") {
        int screen_x, screen_y, screen_w, screen_h;
        Fl::screen_xywh(screen_x, screen_y, screen_w, screen_h, 0); // Using screen 0 (primary)

        layout_screen_w = screen_w;
        layout_screen_h = screen_h;

        std::cout << "[gui] Layout resolution: " << screen_w << "x" << screen_h << std::endl;

        border(0);
        set_override();
        resize(screen_x, screen_y, screen_w, screen_h);
        fullscreen();
        // Define layout dimensions (adjust as needed)
        header_height = std::floor(screen_h * 0.19);
        footer_height = std::floor(screen_h * (1 - 0.92));
        footer_y = std::floor(screen_h * 0.92);
        sidebar_visible = false; // Sidebar starts visible
        original_sidebar_width = std::floor(w() * 0.22); // Store this for later

        // Instantiate and place the components
        // Note: The coordinates (x, y, w, h) for each component are relative to the parent (MainWindow)
        header_comp = new Header(0, 0, screen_w, header_height, argc, argv);
        // sidebar_comp = new SideBar(0, header_height, original_sidebar_width, screen_h - header_height - footer_height);
        // main_content_comp = new MainContent(original_sidebar_width, header_height, screen_w - original_sidebar_width, screen_h - header_height - footer_height);
        main_content_comp = new MainContent(0, header_height, screen_w, screen_h - header_height - footer_height);
        footer_comp = new Footer(0, footer_y, screen_w, footer_height);
        
        // Set the callback for the hamburger button in the Header
        // header_comp->get_hamburger_button()->callback(toggle_sidebar_cb, this);

        end(); // End the window group, ensuring all children are properly registered
        // resizable(main_content_comp); // Make the main content area resizable with the window
        // size_range(500, 400);
    }

    void updateBalance(int balance){
        if (main_content_comp){
            main_content_comp->updateCoin(balance);
        }
    }

    void updatePauseState(int pause_state){
        if (main_content_comp){
            main_content_comp->updatePauseState(pause_state);
        }
    }

    void updateWaterLevel(std::string wtr1, std::string wtr2, std::string wtr3, std::string wtr4){
        if (main_content_comp){
            main_content_comp->updateWaterLevel(wtr1, wtr2, wtr3, wtr4);
        }
    }

    
    void updateTimer(std::string timer1, std::string timer2, std::string timer3, std::string timer4){
        if (main_content_comp){
            main_content_comp->updateTimer(timer1, timer2, timer3, timer4);
        }
    }
    

    ~MainWindow() {
        delete header_comp;
        // delete sidebar_comp;
        delete main_content_comp;
        delete footer_comp;
    }

private:
    Header* header_comp;
    // SideBar* sidebar_comp;
    MainContent* main_content_comp;
    Footer* footer_comp;

    int header_height;
    int footer_height;
    int footer_y;
    int original_sidebar_width;
    bool sidebar_visible;

public:
    int layout_screen_w = 0;
    int layout_screen_h = 0;
};


MainWindow* g_mainWindow = nullptr;

static void force_fullscreen_once(void* data) {
    MainWindow* win = static_cast<MainWindow*>(data);
    if (!win) {
        return;
    }

    int sx, sy, sw, sh;
    Fl::screen_xywh(sx, sy, sw, sh, 0);

    win->border(0);
    win->resize(sx, sy, sw, sh);
    win->fullscreen();
    win->redraw();
    Fl::flush();

    std::cout << "[gui] Fullscreen enforced at " << sw << "x" << sh << std::endl;
}

// After the window is shown, verify the layout was built with the correct screen
// resolution. On some boots the GPU hasn't negotiated the real resolution yet when
// the constructor runs, resulting in a mismatched layout. If that happened, exit
// so systemd restarts us — by then the display will be fully ready.
static void deferred_fullscreen_check(void* data) {
    MainWindow* win = static_cast<MainWindow*>(data);
    int sx, sy, sw, sh;
    Fl::screen_xywh(sx, sy, sw, sh, 0);
    if (sw != win->layout_screen_w || sh != win->layout_screen_h) {
        std::cerr << "[gui] Layout was built at " << win->layout_screen_w << "x" << win->layout_screen_h
                  << " but screen is now " << sw << "x" << sh
                  << " — exiting for systemd auto-restart with correct resolution." << std::endl;
        exit(1);
    }
    std::cout << "[gui] Display resolution verified: " << sw << "x" << sh << std::endl;
}



// --- Conceptual setup() and loop() for Client ---
void client_app_setup() {
    if (!initialize_socket_environment()) {
        // Handle error, e.g., exit or return
    }
    if (!establish_server_connection()) {
        // Handle error, e.g., exit or return
    }
}


void client_app_loop(void* data) {
    if (g_client_socket != (SocketHandle)-1) {
        receive_data_from_server(data);
        send_periodic_acknowledgement();
    } else {
        // Throttle reconnect attempts without blocking the FLTK event loop.
        // sleep_for() must NOT be used here — it freezes redraws.
        static auto last_reconnect = std::chrono::steady_clock::now() - std::chrono::seconds(10);
        auto now = std::chrono::steady_clock::now();
        if (std::chrono::duration_cast<std::chrono::seconds>(now - last_reconnect).count() >= 2) {
            last_reconnect = now;
            std::cout << "Attempting to reconnect to server..." << std::endl;
            establish_server_connection();
        }
    }
}

// --- Client Functions ---

// 1. Initializes platform-specific socket library
bool initialize_socket_environment() {
#ifdef _WIN32
    WSADATA wsaData;
    if (WSAStartup(MAKEWORD(2, 2), &wsaData) != 0) {
        std::cerr << "WSAStartup failed." << std::endl;
        return false;
    }
#endif
    return true;
}

// 2. Creates the client socket and connects to the server
bool establish_server_connection() {
    g_client_socket = socket(AF_INET, SOCK_STREAM, 0);
    if (g_client_socket == (SocketHandle)-1) {
        perror("Failed to create client socket");
        return false;
    }

    sockaddr_in serv_addr;
    serv_addr.sin_family = AF_INET;
    serv_addr.sin_port = htons(SERVER_PORT);

#ifdef _WIN32
    if (InetPton(AF_INET, SERVER_IP, &serv_addr.sin_addr) != 1) {
        std::cerr << "Invalid server address (InetPton failed)." << std::endl;
        CLOSESOCKET(g_client_socket);
        return false;
    }
#else
    if (inet_pton(AF_INET, SERVER_IP, &serv_addr.sin_addr) <= 0) {
        std::cerr << "Invalid server address/ Address not supported" << std::endl;
        CLOSESOCKET(g_client_socket);
        return false;
    }
#endif

    std::cout << "Attempting to connect to server at " << SERVER_IP << ":" << SERVER_PORT << "..." << std::endl;
    if (connect(g_client_socket, (struct sockaddr *)&serv_addr, sizeof(serv_addr)) < 0) {
        perror("Connection Failed");
        CLOSESOCKET(g_client_socket);
        g_client_socket = (SocketHandle)-1;
        return false;
    }
    std::cout << "Successfully connected to server!" << std::endl;

    set_socket_non_blocking(g_client_socket); // Set socket non-blocking for data transfer
    g_last_acknowledgement_send_time = std::chrono::steady_clock::now(); // Initialize timer
    return true;
}

// 3. Receives data from the server without blocking
void receive_data_from_server(void* data) {
    char buffer[MAX_BUFFER_SIZE] = {0};
    int bytes_read = recv(g_client_socket, buffer, MAX_BUFFER_SIZE - 1, 0);

#ifdef _WIN32
    if (bytes_read == SOCKET_ERROR) {
        int err = GET_LAST_SOCKET_ERROR();
        if (err == SOCKET_ERROR_WOULDBLOCK) {
            // No data available right now, return
        } else {
            std::cerr << "Error receiving data from server: " << err << ". Disconnecting." << std::endl;
            CLOSESOCKET(g_client_socket);
            g_client_socket = (SocketHandle)-1; // Mark as disconnected
        }
    } else if (bytes_read == 0) {
        std::cout << "Server disconnected gracefully." << std::endl;
        CLOSESOCKET(g_client_socket);
        g_client_socket = (SocketHandle)-1; // Mark as disconnected
    } else {
        buffer[bytes_read] = '\0'; // Null-terminate
        update_gui_display(std::string(buffer)); // Pass data to conceptual GUI
    }
#else
    if (bytes_read == -1) {
        if (GET_LAST_SOCKET_ERROR() == SOCKET_ERROR_WOULDBLOCK) {
            // No data available right now, return
        } else {
            perror("Error receiving data from server. Disconnecting.");
            CLOSESOCKET(g_client_socket);
            g_client_socket = (SocketHandle)-1; // Mark as disconnected
        }
    } else if (bytes_read == 0) {
        std::cout << "Server disconnected gracefully." << std::endl;
        CLOSESOCKET(g_client_socket);
        g_client_socket = (SocketHandle)-1; // Mark as disconnected
    } else {
        buffer[bytes_read] = '\0'; // Null-terminate
        update_gui_display(std::string(buffer)); // Pass data to conceptual GUI
    }
#endif
    MainWindow* mw = static_cast<MainWindow*>(data);
        

    if (mw) {
        
        // Convert char buffer to std::string for easier manipulation
        std::string data_str(buffer);

        // Create a stringstream from the data
        std::stringstream ss(data_str);
        std::string segment;

        int first_item_value = 0; // Initialize in case parsing fails

        // Extract the first segment
        if (std::getline(ss, segment, ':')) {
            // Try to convert the first segment to an integer
            try {
                std::getline(ss, segment, ',');
                first_item_value = std::stoi(segment);
                std::string item_value1 = (std::getline(ss, segment, ',')) ? segment : "0";
                std::string item_value2 = (std::getline(ss, segment, ',')) ? segment : "0";
                std::string item_value3 = (std::getline(ss, segment, ',')) ? segment : "0";
                std::string item_value4 = (std::getline(ss, segment, ',')) ? segment : "0";
                
                std::string waterLevelOneZero_PIN1 = (std::getline(ss, segment, ',')) ? segment : "0";
                std::string waterLevelOneZero_PIN2 = (std::getline(ss, segment, ',')) ? segment : "0";
                std::string waterLevelOneZero_PIN3 = (std::getline(ss, segment, ',')) ? segment : "0";
                std::string waterLevelOneZero_PIN4 = (std::getline(ss, segment, ',')) ? segment : "0";
                
                std::string pause_state_str = (std::getline(ss, segment, ',')) ? segment : "0";
                int pause_state = std::stoi(pause_state_str);
                
                long long total_seconds_ll1 = std::stoll(item_value1);
                long long total_seconds_ll2 = std::stoll(item_value2);
                long long total_seconds_ll3 = std::stoll(item_value3);
                long long total_seconds_ll4 = std::stoll(item_value4);
                
                total_seconds_ll1 = (total_seconds_ll1 > 0) ? total_seconds_ll1 : 0;
                total_seconds_ll2 = (total_seconds_ll2 > 0) ? total_seconds_ll2 : 0;
                total_seconds_ll3 = (total_seconds_ll3 > 0) ? total_seconds_ll3 : 0;
                total_seconds_ll4 = (total_seconds_ll4 > 0) ? total_seconds_ll4 : 0;

                std::string formatted_time_large1 = convertMillisecondsToMMMSS(total_seconds_ll1);
                std::string formatted_time_large2 = convertMillisecondsToMMMSS(total_seconds_ll2);
                std::string formatted_time_large3 = convertMillisecondsToMMMSS(total_seconds_ll3);
                std::string formatted_time_large4 = convertMillisecondsToMMMSS(total_seconds_ll4);

                std::cout << "First item (integer): " << first_item_value << std::endl;
                std::cout << "Pause State (integer): " << pause_state << std::endl;

                std::cout << "1: " << formatted_time_large1 << " | " << waterLevelOneZero_PIN1 << std::endl;
                std::cout << "2: " << formatted_time_large2 << " | " << waterLevelOneZero_PIN2 <<  std::endl;
                std::cout << "3: " << formatted_time_large3 << " | " << waterLevelOneZero_PIN3 <<  std::endl;
                std::cout << "4: " << formatted_time_large4 << " | " << waterLevelOneZero_PIN4 <<  std::endl;

                mw->updateBalance(first_item_value);
                mw->updateWaterLevel(waterLevelOneZero_PIN1, waterLevelOneZero_PIN2, waterLevelOneZero_PIN3, waterLevelOneZero_PIN4);
                mw->updatePauseState(pause_state);
                mw->updateTimer(formatted_time_large1, formatted_time_large2, formatted_time_large3, formatted_time_large4);
            } catch (const std::invalid_argument& e) {
                std::cerr << "Error: First item is not a valid integer. " << e.what() << std::endl;
            } catch (const std::out_of_range& e) {
                std::cerr << "Error: First item integer out of range. " << e.what() << std::endl;
            }
        } else {
            // std::cerr << "Error: Could not extract first item from data." << std::endl;
        }

        // // Simulate coins increasing over time
        // static int current_simulated_coins = 0;
        // current_simulated_coins++; // Or get actual value from your game/app logic
        // if (current_simulated_coins % 100 == 0) { // Update every 100 "ticks"
        //     g_mainWindow->simulateCoinChange(current_simulated_coins);
        //     g_mainWindow->redraw();
        // }
    }
}


// 4. Sends periodic acknowledgements to the server
void send_periodic_acknowledgement() {
    auto now = std::chrono::steady_clock::now();
    if (std::chrono::duration_cast<std::chrono::seconds>(now - g_last_acknowledgement_send_time) >= ACK_SEND_INTERVAL) {
        const char* ack_message = "Client ACK";
        int bytes_sent = send(g_client_socket, ack_message, strlen(ack_message), 0);

#ifdef _WIN32
        if (bytes_sent == SOCKET_ERROR) {
            int err = GET_LAST_SOCKET_ERROR();
            if (err == SOCKET_ERROR_WOULDBLOCK) {
                // Send buffer full, try again next time (or implement send queue)
                // std::cerr << "Send buffer full (client ACK)." << std::endl;
            } else {
                std::cerr << "Error sending ACK to server: " << err << ". Disconnecting." << std::endl;
                CLOSESOCKET(g_client_socket);
                g_client_socket = (SocketHandle)-1; // Mark as disconnected
            }
        } else {
            std::cout << "Sent to Server: " << ack_message << std::endl;
            g_last_acknowledgement_send_time = now; // Update last send time
        }
#else
        if (bytes_sent == -1) {
            if (GET_LAST_SOCKET_ERROR() == SOCKET_ERROR_WOULDBLOCK) {
                // Send buffer full, try again next time
                // perror("send buffer full (client ACK)");
            } else {
                perror("Error sending ACK to server. Disconnecting.");
                CLOSESOCKET(g_client_socket);
                g_client_socket = (SocketHandle)-1; // Mark as disconnected
            }
        } else {
            std::cout << "Sent to Server: " << ack_message << std::endl;
            g_last_acknowledgement_send_time = now; // Update last send time
        }
#endif
    }
}


// 5. Cleans up platform-specific socket resources
void cleanup_socket_environment() {
    if (g_client_socket != (SocketHandle)-1) {
        CLOSESOCKET(g_client_socket);
        g_client_socket = (SocketHandle)-1;
    }
#ifdef _WIN32
    WSACleanup();
#endif
    std::cout << "Client socket environment cleaned up." << std::endl;
}



// --- 3. Main application entry point ---
int main(int argc, char *argv[]) {
    Fl::scheme("gtk+");
    MainWindow window(argc, argv);
    window.show(argc, argv);
    g_mainWindow = &window;
    force_fullscreen_once(g_mainWindow);

    // Force the window to paint before the socket connection attempt,
    // so the display is visible even if coin_slot isn't running yet.
    Fl::check();

    // Re-apply fullscreen during early startup. On Raspberry Pi LCD boots,
    // the window manager/display can settle after the first show() call.
    Fl::add_timeout(0.25, force_fullscreen_once, g_mainWindow);
    Fl::add_timeout(1.0, force_fullscreen_once, g_mainWindow);
    Fl::add_timeout(2.0, force_fullscreen_once, g_mainWindow);

    // 3 s after startup, verify the screen resolution matches what the layout was
    // built with. If it differs (GPU hadn't finished negotiating resolution at boot),
    // we exit and systemd restarts us with the correct resolution already settled.
    Fl::add_timeout(3.0, deferred_fullscreen_check, g_mainWindow);

    // Connect to coin_slot server AFTER the window is visible.
    // If it fails (coin_slot not up yet), client_app_loop will retry every 2s
    // without blocking the FLTK event loop.
    client_app_setup();

    Fl::add_idle(client_app_loop, g_mainWindow);
    return Fl::run();
}

// Function to trim whitespace from the beginning and end of a string
std::string trim(const std::string &s)
{
  size_t start = s.find_first_not_of(" \t\n\r\f\v");
  size_t end = s.find_last_not_of(" \t\n\r\f\v");
  if (std::string::npos == start)
  {
    return ""; // All whitespace
  }
  return s.substr(start, end - start + 1);
}


/**
 * @brief Loads environment variables from a specified .env file into a map.
 * Supports basic KEY=VALUE format, ignores lines starting with #, and trims whitespace.
 *
 * @param filepath The path to the .env file (e.g., "config.env").
 * @return A std::map<std::string, std::string> containing the loaded environment variables.
 */
std::map<std::string, std::string> loadEnv(const std::string &filepath = ".env")
{
  std::map<std::string, std::string> env_vars;
  std::ifstream file(filepath);

  if (!file.is_open())
  {
    std::cerr << "Warning: Could not open .env file at " << filepath << ". Continuing without it." << std::endl;
    return env_vars; // Return empty map if file not found
  }

  std::string line;
  while (std::getline(file, line))
  {
    line = trim(line); // Trim leading/trailing whitespace

    // Ignore empty lines and comments
    if (line.empty() || line[0] == '#')
    {
      continue;
    }

    // Find the first '='
    size_t equals_pos = line.find('=');
    if (equals_pos == std::string::npos)
    {
      std::cerr << "Warning: Skipping malformed line in .env: " << line << std::endl;
      continue; // Not a key=value pair
    }

    std::string key = trim(line.substr(0, equals_pos));
    std::string value = trim(line.substr(equals_pos + 1));

    // Optional: Handle quoted values (simple double quotes)
    if (value.length() >= 2 && value.front() == '"' && value.back() == '"')
    {
      value = value.substr(1, value.length() - 2);
      // If you need to handle escaped quotes inside, you'd add more logic here
      // e.g., replacing \\" with "
    }
    else if (value.length() >= 2 && value.front() == '\'' && value.back() == '\'')
    { // Single quotes
      value = value.substr(1, value.length() - 2);
    }

    if (!key.empty())
    {
      env_vars[key] = value;
    }
  }

  file.close();
  std::cout << ".env file loaded from: " << filepath << std::endl;
  return env_vars;
}
