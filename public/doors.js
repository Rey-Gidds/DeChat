const user = io('https://dechat-o5h4.onrender.com');
const createRoomBtn = document.getElementById("createRoom");
const active_rooms = document.getElementById("active_rooms");


user.on('Sustain_connection' , () => {
    console.log('Reviving Connection.');
})

createRoomBtn.addEventListener('click', () => {
    localStorage.setItem("isCreate", JSON.stringify(true));
    user.disconnect()
    window.location.href = "create_room.html";
});

user.on("displayAvailableRooms", (rooms , room_title , room_max_connections) => {
    displayRooms(rooms , room_title , room_max_connections);
});

user.on('destroyRoomBlock' , (room_key) => {
    let room = document.getElementById(room_key)
    room.remove()
})

function displayRooms(rooms , room_titles , room_max_connections) {
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
    // room == roomKey for the available rooms.
    Object.keys(rooms).forEach((room) => {
        let roomBlock = document.createElement('div');
        let room_length = rooms[room].length;
        let max_connections = room_max_connections[room]
        roomBlock.className = "room_block";
        roomBlock.id = `${room}`;
        
        // Show capacity status color based on room fullness
        let statusColor;
        if(room_length < max_connections) statusColor = 'var(--success-color)';
        else statusColor = 'var(--danger-color)'
        
        roomBlock.innerHTML = `
            <h2 class="roomTitle">${room_titles[room]}</h2>
            <h3>${room}</h3>
            <div class="members" style="--status-color: ${statusColor}">${room_length} / ${max_connections}</div>
            <button class="joinBtn" onclick='joinCall("${room}", false)'>Join Room</button>
        `;
        active_rooms.appendChild(roomBlock);
    });
}

function joinCall(roomKey, isCreate) {
    localStorage.setItem("isCreate", JSON.stringify(isCreate));
    localStorage.setItem("roomKey", JSON.stringify(roomKey));
    user.disconnect()
    window.location.href = "index.html";
}