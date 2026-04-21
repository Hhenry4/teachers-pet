// Configuration
const CLIENT_ID = '613541445993-m2vtpvjfk246rup426ba44nidgh2ibha.apps.googleusercontent.com';
const SCOPES = [
    'https://www.googleapis.com/auth/classroom.courses.readonly',
    'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
    'https://www.googleapis.com/auth/classroom.student-submissions.me.readonly'
].join(' ');

// State
let tokenClient;
let accessToken = null;
let coursesList = [];
let allAssignments = [];

// DOM Elements
const authBtn = document.getElementById('auth-btn');
const revokeBtn = document.getElementById('revoke-btn');
const authStatus = document.getElementById('auth-status');
const authView = document.getElementById('auth-view');
const dashView = document.getElementById('dashboard-view');
const assignmentsGrid = document.getElementById('assignments-grid');
const spinner = document.getElementById('loading-spinner');
const courseFilter = document.getElementById('course-filter');
const refreshBtn = document.getElementById('refresh-btn');
const signoutBtn = document.getElementById('signout-btn');

// Initialize Google GIS
window.onload = function() {
    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        callback: (tokenResponse) => {
            if (tokenResponse && tokenResponse.access_token) {
                accessToken = tokenResponse.access_token;
                switchToDashboard();
                fetchClassroomData();
            }
        },
    });
};

// Event Listeners
authBtn.addEventListener('click', () => {
    authStatus.textContent = 'Opening Google Login...';
    tokenClient.requestAccessToken({prompt: 'consent'});
});

signoutBtn.addEventListener('click', handleSignout);
refreshBtn.addEventListener('click', fetchClassroomData);
courseFilter.addEventListener('change', renderAssignments);

function handleSignout() {
    if (accessToken) {
        google.accounts.oauth2.revoke(accessToken, () => {
            accessToken = null;
            authView.style.display = 'flex';
            dashView.style.display = 'none';
            authStatus.textContent = 'Signed out successfully.';
            assignmentsGrid.innerHTML = '';
        });
    }
}

function switchToDashboard() {
    authView.style.display = 'none';
    dashView.style.display = 'block';
}

// Fetch Logic
async function fetchWithToken(url) {
    if (!accessToken) throw new Error("No Access Token");
    const res = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${accessToken}`
        }
    });
    if (!res.ok) throw new Error(`API Error: ${res.status}`);
    return await res.json();
}

async function fetchClassroomData() {
    try {
        setLoading(true);
        assignmentsGrid.innerHTML = '';
        allAssignments = [];
        
        // 1. Fetch Courses
        const coursesData = await fetchWithToken('https://classroom.googleapis.com/v1/courses?courseStates=ACTIVE');
        coursesList = coursesData.courses || [];
        
        populateCourseFilter();

        // 2. Fetch Assignments & Submissions concurrently
        const fetchPromises = coursesList.map(async (course) => {
            // Fetch CourseWork
            const courseworkData = await fetchWithToken(`https://classroom.googleapis.com/v1/courses/${course.id}/courseWork`);
            const works = courseworkData.courseWork || [];
            
            // For each coursework, fetch submissions (We could batch or just get submissions per coursework)
            // To save API limits, studentSubmissions.list can list all submissions for a course by omitting courseWorkId
            // Wait, v1/courses/{courseId}/courseWork/-/studentSubmissions gets ALL submissions for a course! Let's use that.
            
            let submissionsMap = {};
            try {
                const subsData = await fetchWithToken(`https://classroom.googleapis.com/v1/courses/${course.id}/courseWork/-/studentSubmissions`);
                const subs = subsData.studentSubmissions || [];
                subs.forEach(s => {
                    submissionsMap[s.courseWorkId] = s.state; // states: "TURNED_IN", "RETURNED", "CREATED", "NEW", etc.
                });
            } catch (e) {
                console.error("Failed to load submissions for course: " + course.name, e);
            }

            return works.map(w => {
                return {
                    id: w.id,
                    courseId: course.id,
                    courseName: course.name,
                    title: w.title,
                    dueDate: w.dueDate ? new Date(w.dueDate.year, w.dueDate.month - 1, w.dueDate.day, w.dueTime?.hours || 23, w.dueTime?.minutes || 59) : null,
                    description: w.description,
                    url: w.alternateLink,
                    state: submissionsMap[w.id] || "NEW"
                };
            });
        });

        const results = await Promise.all(fetchPromises);
        allAssignments = results.flat();
        
        // Render
        renderAssignments();
    } catch (error) {
        console.error(error);
        assignmentsGrid.innerHTML = '<p class="text-muted" style="grid-column: 1/-1; text-align:center; font-size: 1.2rem; padding: 2rem;">You have no assignments or classes.</p>';
    } finally {
        setLoading(false);
    }
}

function setLoading(isLoading) {
    if (isLoading) {
        spinner.style.display = 'flex';
        refreshBtn.classList.add('spinner'); // add small simple spin if needed
    } else {
        spinner.style.display = 'none';
        refreshBtn.classList.remove('spinner');
    }
}

function populateCourseFilter() {
    courseFilter.innerHTML = '<option value="all">All Courses</option>';
    coursesList.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.name;
        courseFilter.appendChild(opt);
    });
}

// Logic Rules
function calculateLogic(assignment) {
    // Determine if missing or turned in
    const isTurnedIn = assignment.state === "TURNED_IN" || assignment.state === "RETURNED";
    let isMissing = false;
    
    // Priority Logic
    let priorityVal = 0; // default Low
    let priorityLabel = 'Low';
    let priorityClass = 'badge-low';
    let cardClass = 'priority-low';

    const now = new Date();

    if (assignment.dueDate) {
        const timeDiff = assignment.dueDate.getTime() - now.getTime();
        const daysDiff = timeDiff / (1000 * 3600 * 24);

        if (daysDiff < 0 && !isTurnedIn) {
            isMissing = true;
        }

        if (isMissing || (daysDiff >= 0 && daysDiff <= 1)) {
            priorityVal = 2;
            priorityLabel = 'High';
            priorityClass = 'badge-high';
            cardClass = 'priority-high';
        } else if (daysDiff > 1 && daysDiff <= 4) {
            priorityVal = 1;
            priorityLabel = 'Medium';
            priorityClass = 'badge-medium';
            cardClass = 'priority-medium';
        }
    } else {
        // No due date = low priority
    }

    if (isTurnedIn) {
        // override priority if done
        priorityVal = -1;
        priorityLabel = 'Done';
        priorityClass = 'badge-low'; // green
        cardClass = 'priority-low';
    }

    let statusText = isTurnedIn ? "Turned In" : (isMissing ? "Missing" : "Assigned");
    let statusClass = isTurnedIn ? "turned-in" : (isMissing ? "missing" : "assigned");

    return { priorityVal, priorityLabel, priorityClass, cardClass, statusText, statusClass };
}

function renderAssignments() {
    const filterId = courseFilter.value;
    assignmentsGrid.innerHTML = '';

    let filtered = allAssignments.filter(a => filterId === 'all' || a.courseId === filterId);

    // Sort by priority (High -> Medium -> Low -> Done) then Due Date
    const enhanced = filtered.map(a => {
        const pInfo = calculateLogic(a);
        return { ...a, _score: pInfo.priorityVal, pInfo };
    }).sort((a, b) => {
        if (b._score !== a._score) return b._score - a._score;
        if (!a.dueDate && !b.dueDate) return 0;
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return a.dueDate - b.dueDate;
    });

    if (enhanced.length === 0) {
        assignmentsGrid.innerHTML = '<p class="text-muted" style="grid-column: 1/-1; text-align:center; font-size: 1.2rem; padding: 2rem;">You have no assignments or classes.</p>';
        return;
    }

    enhanced.forEach((assignment, index) => {
        const { pInfo } = assignment;
        const staggerClass = `stagger-${Math.min(index % 5 + 1, 5)}`;
        
        const dateStr = assignment.dueDate 
            ? assignment.dueDate.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute:'2-digit' })
            : 'No due date';

        let tooltipHTML = '';
        if (assignment.description) {
            const safeDesc = assignment.description.replace(/</g, "&lt;").replace(/>/g, "&gt;");
            tooltipHTML = `<div class="card-tooltip">${safeDesc.replace(/\n/g, '<br>')}</div>`;
        }

        const card = document.createElement('div');
        card.className = `assignment-card ${pInfo.cardClass} slide-up ${staggerClass}`;
        
        card.innerHTML = `
            <div class="card-header">
                <div>
                    <div class="course-name">${assignment.courseName}</div>
                    <div class="assignment-title">${assignment.title}</div>
                </div>
                <div class="badge ${pInfo.priorityClass}">${pInfo.priorityLabel} Prioritiy</div>
            </div>
            
            <div class="card-footer">
                <div class="due-date">
                    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>
                    ${dateStr}
                </div>
                <div class="status ${pInfo.statusClass}">${pInfo.statusText}</div>
            </div>
            ${tooltipHTML}
        `;
        
        // Add click listener to open assignment in Classroom
        card.style.cursor = 'pointer';
        card.addEventListener('click', () => {
            window.open(assignment.url, '_blank');
        });

        assignmentsGrid.appendChild(card);
    });
}
