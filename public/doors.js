const user = io();
const createRoomBtn = document.getElementById("createRoom");
const active_rooms = document.getElementById("active_rooms");

createRoomBtn.addEventListener('click', () => {
    localStorage.setItem("isCreate", JSON.stringify(true));
    window.location.href = "index.html";
});

user.on("displayAvailableRooms", (rooms , room_title) => {
    displayRooms(rooms , room_title);
});

user.on('destroyRoomBlock' , (room_key) => {
    let room = document.getElementById(room_key)
    room.remove()
})

function displayRooms(rooms , room_titles) {
    // Clear previous content
    active_rooms.innerHTML = '';
    
    // Check if there are rooms to display
    if (Object.keys(rooms).length === 0) {
        const emptyState = document.createElement('div');
        emptyState.className = 'empty-state';
        emptyState.textContent = 'No active rooms. Create one to get started!';
        active_rooms.appendChild(emptyState);
        return;
    }
    
    // Display rooms
    Object.keys(rooms).forEach((room) => {
        let roomBlock = document.createElement('div');
        let room_length = rooms[room].length;
        roomBlock.className = "room_block";
        roomBlock.id = `${room}`;
        
        // Show capacity status color based on room fullness
        let statusColor = room_length < 6 ? 'var(--success-color)' : 
                            room_length < 8 ? '#f0ad4e' : 'var(--danger-color)';
        
        roomBlock.innerHTML = `
            <h2 class="roomTitle">${room_titles[room]}</h2>
            <h3>${room}</h3>
            <div class="members" style="--status-color: ${statusColor}">${room_length} / 8</div>
            <button class="joinBtn" onclick='joinCall("${room}", false)'>Join Room</button>
        `;
        active_rooms.appendChild(roomBlock);
    });
}

function joinCall(roomKey, isCreate) {
    localStorage.setItem("isCreate", JSON.stringify(isCreate));
    localStorage.setItem("roomKey", JSON.stringify(roomKey));
    window.location.href = "index.html";
}